#!/usr/bin/env node

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import MarkdownIt from "markdown-it";
import autolinkRule from "markdown-it/lib/rules_inline/autolink.mjs";
import imageRule from "markdown-it/lib/rules_inline/image.mjs";
import linkRule from "markdown-it/lib/rules_inline/link.mjs";
import parseSpdxExpression from "spdx-expression-parse";
import { parse } from "yaml";

const REQUIRED_REFERENCES = new Map();

const SHA = /^[0-9a-f]{40}$/;
const PINNED_BLOB =
  /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([0-9a-f]{40})\/[^#]+#L\d+(?:-L\d+)?$/;
const PINNED_COMMIT =
  /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/commit\/([0-9a-f]{40})$/;
const LINE_ANCHOR = /^#L\d+(?:-L\d+)?$/;
const GITHUB_ROUTES = new Set(["blob", "commit", "tree"]);
const markdown = new MarkdownIt({ html: true, linkify: true });
markdown.core.ruler.disable(["text_join"]);
const HTML_COMMENT = /<!--[\s\S]*?-->/g;

function stripHtmlComments(value) {
  let previous;
  let current = value;
  do {
    previous = current;
    current = current.replace(HTML_COMMENT, "");
  } while (current !== previous);
  return current;
}

function captureInlineSource(parser, name, rule, tokenTypes) {
  parser.inline.ruler.at(name, (state, silent) => {
    const start = state.pos;
    const firstToken = state.tokens.length;
    const matched = rule(state, silent);
    if (matched && !silent) {
      const sourceMarkup = state.src.slice(start, state.pos);
      for (const token of state.tokens.slice(firstToken)) {
        if (tokenTypes.has(token.type)) {
          token.meta = { ...token.meta, sourceMarkup };
        }
      }
    }
    return matched;
  });
}

captureInlineSource(markdown, "link", linkRule, new Set(["link_open"]));
captureInlineSource(markdown, "image", imageRule, new Set(["image"]));
captureInlineSource(markdown, "autolink", autolinkRule, new Set(["link_open"]));

function lexicalDestination(sourceMarkup, markup) {
  if (!sourceMarkup) {
    return null;
  }
  if (markup === "autolink") {
    return sourceMarkup.slice(1, -1);
  }
  const marker = sourceMarkup.lastIndexOf("](");
  if (marker === -1 || !sourceMarkup.endsWith(")")) {
    return null;
  }
  const destinationAndTitle = sourceMarkup.slice(marker + 2, -1).trim();
  if (destinationAndTitle.startsWith("<")) {
    const close = destinationAndTitle.indexOf(">");
    return close === -1
      ? null
      : destinationAndTitle.slice(1, close);
  }
  return destinationAndTitle.split(/\s/, 1)[0];
}

function markdownDestinations(content, label) {
  const destinations = [];
  const errors = [];
  const rawHtmlTags = new Set();

  function visit(tokens) {
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (["html_block", "html_inline"].includes(token.type)) {
        const withoutComments = stripHtmlComments(token.content);
        if (withoutComments !== token.content) {
          if (withoutComments.trim()) {
            visit(markdown.parse(withoutComments, {}));
          }
          continue;
        }
        for (const match of token.content.matchAll(/<\s*\/?\s*(a|img)\b/gi)) {
          rawHtmlTags.add(match[1].toLowerCase());
        }
      }
      if (
        token.type === "text_special" &&
        token.content === "<" &&
        token.markup.startsWith("&")
      ) {
        let rendered = "";
        for (
          let candidateIndex = index;
          candidateIndex < tokens.length;
          candidateIndex += 1
        ) {
          const candidate = tokens[candidateIndex];
          if (!["text", "text_special"].includes(candidate.type)) {
            break;
          }
          rendered += candidate.content;
          if (rendered.includes(">")) {
            break;
          }
        }
        const encodedTag = /^<\s*\/?\s*(a|img)\b/i.exec(rendered);
        if (encodedTag) {
          rawHtmlTags.add(encodedTag[1].toLowerCase());
        }
      }
      if (token.type === "link_open") {
        const href = token.attrGet("href");
        if (href) {
          const linkedText = tokens[index + 1];
          const hasTitle = token.attrIndex("title") >= 0;
          const hasAdjacentDelimiterSequence =
            token.markup === "linkify" &&
            tokens[index + 2]?.type === "link_close" &&
            tokens[index + 3]?.type === "text" &&
            tokens[index + 3].content.startsWith("](");
          destinations.push({
            destination:
              token.markup === "linkify" && linkedText?.type === "text"
                ? linkedText.content
                : href,
            href,
            markup: token.markup,
            hasTitle,
            hasAdjacentDelimiterSequence,
            lexicalDestination: hasTitle
              ? null
              : lexicalDestination(token.meta?.sourceMarkup, token.markup)
          });
        }
      } else if (token.type === "image") {
        const source = token.attrGet("src");
        if (source) {
          const hasTitle = token.attrIndex("title") >= 0;
          destinations.push({
            destination: source,
            href: source,
            markup: "image",
            hasTitle,
            lexicalDestination: hasTitle
              ? null
              : lexicalDestination(token.meta?.sourceMarkup, token.markup)
          });
        }
      }
      if (token.children) {
        visit(token.children);
      }
    }
  }

  visit(markdown.parse(content, {}));
  for (const tag of rawHtmlTags) {
    errors.push(
      `${label}: raw HTML <${tag}> tags are unsupported; use canonical Markdown`
    );
  }
  return { destinations, errors };
}

function decodePathForClassification(pathname) {
  if (/%(?![0-9a-f]{2})/i.test(pathname)) {
    throw new Error("malformed percent encoding");
  }
  return {
    decoded: decodeURIComponent(pathname),
    encodedSeparator: /%(?:2f|5c)/i.test(pathname)
  };
}

function decodeFilePath(pathname) {
  const result = decodePathForClassification(pathname);
  const { decoded } = result;
  if (/%[0-9a-f]{2}/i.test(decoded)) {
    throw new Error("nested percent encoding");
  }
  return result;
}

function withoutQueryOrFragment(destination) {
  for (let index = 0; index < destination.length; index += 1) {
    if (destination[index] === "&") {
      const entity = /^&#(?:\d+|x[0-9a-f]+);/i.exec(destination.slice(index));
      if (entity) {
        index += entity[0].length - 1;
        continue;
      }
    }
    if (destination[index] === "?" || destination[index] === "#") {
      return destination.slice(0, index);
    }
  }
  return destination;
}

function rawPathname(destination, form) {
  const withoutQuery = withoutQueryOrFragment(destination);
  if (form === "repository-relative") {
    return withoutQuery;
  }
  if (form === "bare") {
    const separator = withoutQuery.indexOf("/");
    return separator === -1 ? "/" : withoutQuery.slice(separator);
  }
  const authorityStart =
    form === "protocol-relative"
      ? 2
      : withoutQuery.indexOf("://") === -1
        ? -1
        : withoutQuery.indexOf("://") + 3;
  if (authorityStart === -1) {
    return null;
  }
  const separator = withoutQuery.indexOf("/", authorityStart);
  return separator === -1 ? "/" : withoutQuery.slice(separator);
}

function classifyGitHubDestination({
  destination,
  href,
  markup,
  hasTitle,
  hasAdjacentDelimiterSequence,
  lexicalDestination: capturedDestination
}) {
  let form = "absolute";
  let parsed;

  try {
    if (href.startsWith("//")) {
      form = "protocol-relative";
      parsed = new URL(`https:${href}`);
    } else if (href.startsWith("/")) {
      form = "repository-relative";
      parsed = new URL(href, "https://github.com");
    } else if (
      /^github\.com(?::\d+)?(?:\/|$)/i.test(
        markup === "linkify" ? destination : href
      )
    ) {
      form = "bare";
      parsed = new URL(markup === "linkify" ? href : `http://${href}`);
    } else {
      parsed = new URL(href);
    }
  } catch {
    return null;
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname !== "github.com" && hostname.replace(/\.+$/, "") !== "github.com") {
    return null;
  }

  if (hasTitle) {
    return {
      destination: href,
      error: "GitHub citation titles are unsupported"
    };
  }

  if (hasAdjacentDelimiterSequence || /[\[\]()]/.test(parsed.pathname)) {
    return {
      destination: href,
      error:
        "GitHub citation path contains unencoded Markdown delimiter-sensitive characters"
    };
  }

  const lexical = capturedDestination ?? destination;
  const originalPathname = rawPathname(lexical, form);
  let decodedPath;
  let encodedSeparator;
  try {
    ({ decoded: decodedPath, encodedSeparator } = decodePathForClassification(
      parsed.pathname
    ));
  } catch (error) {
    return {
      destination,
      error: `GitHub citation has ${error.message}`
    };
  }

  const repeatedPathSeparators = /\/{2,}/.test(decodedPath);
  const segments = decodedPath.replace(/\\/g, "/").replace(/\/+/g, "/").split("/");
  if (segments[0] === "") {
    segments.shift();
  }
  const [owner, repo, route, ref, ...sourcePath] = segments;
  if (!GITHUB_ROUTES.has(route)) {
    if (/%[0-9a-f]{2}/i.test(decodedPath)) {
      return {
        destination: lexical,
        error: "GitHub citation has nested percent encoding"
      };
    }
    if (
      originalPathname !== null &&
      /%(?![0-9a-f]{2})/i.test(originalPathname)
    ) {
      return {
        destination: lexical,
        error: "GitHub citation has malformed percent encoding"
      };
    }
    return null;
  }
  const literalStructuralPath = `/${owner}/${repo}/${route}/${ref}`;
  const literalStructuralSegments =
    originalPathname !== null &&
    (originalPathname === literalStructuralPath ||
      originalPathname.startsWith(`${literalStructuralPath}/`));
  const lexicalFilePath = literalStructuralSegments
    ? originalPathname.slice(literalStructuralPath.length)
    : "";
  let decodedLexicalFilePath = "";
  let lexicalFilePathError = null;
  if (lexicalFilePath) {
    try {
      ({ decoded: decodedLexicalFilePath } = decodeFilePath(lexicalFilePath));
    } catch (error) {
      lexicalFilePathError = `GitHub citation file path has ${error.message}`;
    }
  }
  const pathNormalizationSegments = decodedLexicalFilePath
    .split("/")
    .some((segment) => segment === "." || segment === "..");
  const nonPercentFilePathEncoding =
    /&(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]+);|\\/i.test(lexicalFilePath);

  const noncanonicalReasons = [];
  if (capturedDestination === null && markup !== "linkify") {
    noncanonicalReasons.push("reference-style");
  }
  if (form !== "absolute") {
    noncanonicalReasons.push(form);
  } else if (parsed.protocol !== "https:") {
    noncanonicalReasons.push(parsed.protocol.slice(0, -1).toUpperCase());
  } else if (parsed.username || parsed.password) {
    noncanonicalReasons.push("userinfo");
  } else if (!/^https:\/\/github\.com(?:\/|$)/i.test(lexical)) {
    noncanonicalReasons.push("absolute-syntax");
  } else if (parsed.port) {
    noncanonicalReasons.push("explicit-port");
  }
  if (repeatedPathSeparators) {
    noncanonicalReasons.push("repeated-path-separator");
  }
  if (encodedSeparator) {
    noncanonicalReasons.push("encoded-path-separator");
  }
  if (!literalStructuralSegments) {
    noncanonicalReasons.push("encoded-structural-segment");
  }
  if (pathNormalizationSegments) {
    noncanonicalReasons.push("path-normalization-segment");
  }
  if (nonPercentFilePathEncoding) {
    noncanonicalReasons.push("non-percent-file-path-encoding");
  }

  return {
    destination: lexical,
    error:
      lexicalFilePathError ??
      (!owner || !repo || !ref
        ? "GitHub citation route is missing owner, repository, or ref"
        : null),
    form,
    noncanonicalReasons,
    owner,
    repo,
    repository: `${owner}/${repo}`,
    route,
    ref,
    sourcePath: sourcePath.join("/"),
    hash: parsed.hash,
    search: parsed.search
  };
}

function inspectGitHubCitations(
  content,
  label,
  { expectedRepository, expectedSha, expectedRepositories } = {}
) {
  const errors = [];
  const citations = [];
  const markdownAnalysis = markdownDestinations(content, label);
  errors.push(...markdownAnalysis.errors);

  for (const destination of markdownAnalysis.destinations) {
    const citation = classifyGitHubDestination(destination);
    if (!citation) {
      continue;
    }
    citations.push(citation);

    if (citation.error) {
      errors.push(`${label}: ${citation.error}: ${citation.destination}`);
      continue;
    }
    for (const reason of citation.noncanonicalReasons) {
      errors.push(
        `${label}: noncanonical ${reason} GitHub ${citation.route} citation ${citation.destination}`
      );
    }
    if (citation.search) {
      errors.push(`${label}: GitHub citation must not contain a query string`);
    }

    const requiredRepository = expectedRepository ?? citation.repository;
    if (citation.repository !== requiredRepository) {
      errors.push(
        `${label}: dossier ${citation.route} citation repository ${citation.repository} does not match ${requiredRepository}`
      );
    }

    const registeredShas = expectedRepositories?.get(citation.repository);
    const requiredSha = expectedSha ?? registeredShas;
    if (
      typeof requiredSha === "string" &&
      citation.ref !== requiredSha
    ) {
      errors.push(
        `${label}: dossier ${citation.route} citation ref ${citation.ref} does not match ${requiredSha}`
      );
    } else if (
      requiredSha instanceof Set &&
      !requiredSha.has(citation.ref)
    ) {
      errors.push(
        `${label}: GitHub ${citation.route} citation ref ${citation.ref} does not match the inventory`
      );
    } else if (!requiredSha && !SHA.test(citation.ref)) {
      errors.push(
        `${label}: mutable GitHub ${citation.route} ref ${citation.ref}`
      );
    }

    if (citation.route === "blob") {
      if (!citation.sourcePath) {
        errors.push(`${label}: GitHub blob citation is missing a source path`);
      }
      if (!LINE_ANCHOR.test(citation.hash)) {
        errors.push(
          `${label}: GitHub blob citation requires an exact line anchor`
        );
      }
    }
  }

  return { citations, errors: errors.sort() };
}

function isRepositoryRelative(candidate) {
  return (
    typeof candidate === "string" &&
    candidate.length > 0 &&
    !path.isAbsolute(candidate) &&
    !candidate.includes("\\") &&
    !candidate.split("/").includes("..")
  );
}

function formatSchemaError(error) {
  const location = error.instancePath || "/";
  return `${location}: ${error.message}`;
}

function checkPinnedBlob(url, expectedRepository, expectedSha, label, errors) {
  const match = PINNED_BLOB.exec(url);
  if (!match) {
    errors.push(`${label}: expected a SHA-pinned GitHub blob URL with line anchors`);
    return;
  }
  const repository = `${match[1]}/${match[2]}`;
  if (repository !== expectedRepository) {
    errors.push(
      `${label}: evidence repository ${repository} does not match ${expectedRepository}`
    );
  }
  if (match[3] !== expectedSha) {
    errors.push(`${label}: evidence SHA ${match[3]} does not match ${expectedSha}`);
  }
}

function validateSpdxExpression(expression, label, errors) {
  if (expression === "NOASSERTION") {
    return;
  }
  try {
    parseSpdxExpression(expression);
  } catch {
    errors.push(`${label}: invalid SPDX expression ${JSON.stringify(expression)}`);
  }
}

export function validateGitHubCitationForms(content, label) {
  return inspectGitHubCitations(content, label).errors;
}

export function validateDossierCitations(dossier, reference) {
  const { citations, errors } = inspectGitHubCitations(
    dossier,
    reference.dossier,
    {
      expectedRepository: reference.repository,
      expectedSha: reference.revision.commit_sha
    }
  );
  if (!citations.some((citation) => citation.route === "blob")) {
    errors.push(`${reference.dossier}: dossier has no GitHub blob citations`);
  }
  return errors.sort();
}

export function validateInventoryDocument(
  document,
  schema,
  { allowPartial = false } = {}
) {
  const errors = [];
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);

  if (!validate(document)) {
    errors.push(...validate.errors.map(formatSchemaError));
    return errors.sort();
  }

  const ids = new Set();
  const claimIds = new Set();

  for (const reference of document.references) {
    if (ids.has(reference.id)) {
      errors.push(`references: duplicate id ${reference.id}`);
    }
    ids.add(reference.id);

    const expected = REQUIRED_REFERENCES.get(reference.id);
    if (!allowPartial && !expected) {
      errors.push(`references: unexpected reference ${reference.id}`);
    } else if (expected) {
      const bindings = [
        ["kind", reference.kind, expected.kind],
        ["canonical_url", reference.canonical_url, expected.canonicalUrl],
        ["repository", reference.repository, expected.repository],
        ["commit_sha", reference.revision.commit_sha, expected.commitSha],
        ["source_path", reference.source_path, expected.sourcePath],
        [
          "source_blob_sha",
          reference.revision.source_blob_sha,
          expected.sourceBlobSha
        ]
      ];
      if (expected.corroboratingSourcePath) {
        bindings.push([
          "corroborating_source_path",
          reference.corroborating_source_path,
          expected.corroboratingSourcePath
        ]);
      }
      for (const [field, actual, required] of bindings) {
        if (actual !== required) {
          errors.push(
            `${reference.id}: ${field} ${JSON.stringify(actual)} does not match required binding ${JSON.stringify(required)}`
          );
        }
      }
    }

    const sha = reference.revision.commit_sha;
    if (!SHA.test(sha)) {
      errors.push(`${reference.id}: commit_sha must be 40 lowercase hex characters`);
    }

    const commitMatch = PINNED_COMMIT.exec(reference.revision.commit_url);
    if (
      !commitMatch ||
      `${commitMatch[1]}/${commitMatch[2]}` !== reference.repository ||
      commitMatch[3] !== sha
    ) {
      errors.push(
        `${reference.id}: commit_url must match the declared repository and exact commit_sha`
      );
    }

    if (
      reference.review.source_hash !==
      `git-sha1:${reference.revision.source_blob_sha}`
    ) {
      errors.push(`${reference.id}: review source_hash must match source_blob_sha`);
    }
    if (reference.review.review_link !== reference.dossier) {
      errors.push(`${reference.id}: review_link must match dossier`);
    }
    if (!isRepositoryRelative(reference.dossier)) {
      errors.push(`${reference.id}: dossier must be repository-relative`);
    }

    if (reference.kind === "repository") {
      if (!isRepositoryRelative(reference.source_path)) {
        errors.push(`${reference.id}: source_path must be repository-relative`);
      }
      if (
        reference.canonical_url !==
        `https://github.com/${reference.repository}`
      ) {
        errors.push(
          `${reference.id}: canonical_url must match the repository owner/name`
        );
      }
      if (reference.revision.ref_type !== "commit") {
        errors.push(`${reference.id}: reviewed repository ref_type must be commit`);
      }
    } else {
      if (!isRepositoryRelative(reference.corroborating_source_path)) {
        errors.push(
          `${reference.id}: corroborating_source_path must be repository-relative`
        );
      }
      if (reference.revision.ref_type !== "website-observation") {
        errors.push(
          `${reference.id}: website ref_type must be website-observation`
        );
      }
    }

    validateSpdxExpression(
      reference.license.spdx_expression,
      `${reference.id}.license.spdx_expression`,
      errors
    );
    if (reference.license.evidence_url === null) {
      if (
        reference.license.spdx_expression !== "NOASSERTION" ||
        !reference.license.evidence_method
      ) {
        errors.push(
          `${reference.id}.license: null evidence_url requires NOASSERTION and evidence_method`
        );
      }
    } else {
      checkPinnedBlob(
        reference.license.evidence_url,
        reference.repository,
        sha,
        `${reference.id}.license.evidence_url`,
        errors
      );
    }

    for (const [index, entry] of reference.copyright.entries()) {
      if (entry.evidence_url === null) {
        if (!entry.evidence_method) {
          errors.push(
            `${reference.id}.copyright[${index}]: null evidence_url requires evidence_method`
          );
        }
      } else {
        checkPinnedBlob(
          entry.evidence_url,
          reference.repository,
          sha,
          `${reference.id}.copyright[${index}].evidence_url`,
          errors
        );
      }
    }

    for (const [index, url] of (
      reference.corroborating_evidence_urls ?? []
    ).entries()) {
      checkPinnedBlob(
        url,
        reference.repository,
        sha,
        `${reference.id}.corroborating_evidence_urls[${index}]`,
        errors
      );
    }

    if (
      reference.use.classification !== "none" &&
      reference.use.local_destination === null
    ) {
      errors.push(
        `${reference.id}: conceptual, adapted, or verbatim use requires local_destination`
      );
    }
    if (
      reference.use.local_destination !== null &&
      !isRepositoryRelative(reference.use.local_destination)
    ) {
      errors.push(
        `${reference.id}: local_destination must be repository-relative`
      );
    }
    if (
      ["adapted", "verbatim"].includes(reference.use.classification) &&
      (reference.use.approval_status !== "approved" ||
        reference.use.legal_review_status !== "approved")
    ) {
      errors.push(
        `${reference.id}: adapted or verbatim use requires approved disposition and legal review`
      );
    }

    for (const claim of reference.material_claims) {
      const qualifiedClaimId = `${reference.id}:${claim.id}`;
      if (claimIds.has(qualifiedClaimId)) {
        errors.push(`${reference.id}: duplicate material claim ${claim.id}`);
      }
      claimIds.add(qualifiedClaimId);
      for (const [index, url] of claim.evidence_urls.entries()) {
        checkPinnedBlob(
          url,
          reference.repository,
          sha,
          `${reference.id}.${claim.id}.evidence_urls[${index}]`,
          errors
        );
      }
    }
  }

  if (!allowPartial) {
    for (const [id, expected] of REQUIRED_REFERENCES) {
      const reference = document.references.find((candidate) => candidate.id === id);
      if (!reference) {
        errors.push(`references: missing required ${expected.kind} reference ${id}`);
      }
    }
    if (document.references.length !== REQUIRED_REFERENCES.size) {
      errors.push(
        `references: expected exactly ${REQUIRED_REFERENCES.size} records, found ${document.references.length}`
      );
    }
  }

  return errors.sort();
}

async function markdownFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await markdownFiles(fullPath)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(fullPath);
    }
  }
  return files;
}

async function validateFiles(root, document) {
  const errors = [];

  for (const reference of document.references) {
    const dossierPath = path.join(root, reference.dossier);
    try {
      const dossier = await readFile(dossierPath, "utf8");
      if (!dossier.includes(`Reference ID: \`${reference.id}\``)) {
        errors.push(
          `${reference.dossier}: missing Reference ID marker for ${reference.id}`
        );
      }
      if (!dossier.includes(reference.revision.commit_sha)) {
        errors.push(
          `${reference.dossier}: missing pinned SHA ${reference.revision.commit_sha}`
        );
      }
      errors.push(...validateDossierCitations(dossier, reference));
    } catch {
      errors.push(`${reference.id}: dossier does not exist at ${reference.dossier}`);
    }

    const destination = reference.use.local_destination;
    if (destination) {
      try {
        const target = path.join(root, destination);
        const targetStat = await stat(target);
        if (!targetStat.isFile()) {
          errors.push(`${reference.id}: local_destination is not a file`);
        }
      } catch {
        errors.push(
          `${reference.id}: local_destination does not exist at ${destination}`
        );
      }
    }
  }

  const candidates = [
    ...(await markdownFiles(path.join(root, "docs"))),
    path.join(root, "README.md"),
    path.join(root, "THIRD_PARTY_NOTICES.md")
  ];
  const dossierFiles = new Set(
    document.references.map((reference) =>
      path.resolve(root, reference.dossier)
    )
  );
  const expectedRepositories = new Map();
  for (const reference of document.references) {
    const shas = expectedRepositories.get(reference.repository) ?? new Set();
    shas.add(reference.revision.commit_sha);
    expectedRepositories.set(reference.repository, shas);
  }

  for (const file of candidates) {
    let content;
    try {
      content = await readFile(file, "utf8");
    } catch {
      continue;
    }
    if (!dossierFiles.has(path.resolve(file))) {
      errors.push(
        ...inspectGitHubCitations(content, path.relative(root, file), {
          expectedRepositories
        }).errors
      );
    }
  }

  return errors.sort();
}

export async function validateProvenance({
  root,
  inventoryPath,
  allowPartial = false,
  skipFiles = false
}) {
  const schemaPath = path.join(
    root,
    "docs/provenance/reference-inventory.schema.json"
  );
  const [schemaSource, inventorySource] = await Promise.all([
    readFile(schemaPath, "utf8"),
    readFile(inventoryPath, "utf8")
  ]);
  const schema = JSON.parse(schemaSource);
  const document = parse(inventorySource);
  const errors = validateInventoryDocument(document, schema, { allowPartial });
  if (!skipFiles && errors.length === 0) {
    errors.push(...(await validateFiles(root, document)));
  }
  return errors.sort();
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const inventoryFlagIndex = process.argv.indexOf("--inventory");
  const root = process.cwd();
  const inventoryPath =
    inventoryFlagIndex === -1
      ? path.join(root, "docs/provenance/reference-inventory.yml")
      : path.resolve(process.argv[inventoryFlagIndex + 1]);

  try {
    const errors = await validateProvenance({
      root,
      inventoryPath,
      allowPartial: args.has("--allow-partial"),
      skipFiles: args.has("--skip-files")
    });
    if (errors.length > 0) {
      for (const error of errors) {
        console.error(`provenance: ${error}`);
      }
      process.exitCode = 1;
      return;
    }
    console.log(`Validated provenance inventory: ${path.relative(root, inventoryPath)}`);
  } catch (error) {
    console.error(`provenance: ${error.message}`);
    process.exitCode = 1;
  }
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
