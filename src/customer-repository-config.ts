const CODEOWNER_PATTERN =
  /^@([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))(?:\/([A-Za-z0-9_.-]+))?$/u;
const REPOSITORY_PATTERN =
  /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/u;

export function codeownersUseRepositoryOwner(input: {
  readonly source: string;
  readonly repository: string;
}): boolean {
  const repository = REPOSITORY_PATTERN.exec(input.repository);
  if (repository === null) {
    throw new TypeError("repository must use a canonical GitHub name");
  }
  const expectedOwner = `@${repository[1]!.toLowerCase()}`;
  let ruleCount = 0;
  for (const line of input.source.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }
    const owners = trimmed.split(/\s+/u).slice(1);
    if (
      owners.length === 0 ||
      owners.some((owner) => {
        const normalized = owner.toLowerCase();
        return (
          normalized !== expectedOwner &&
          !normalized.startsWith(`${expectedOwner}/`)
        );
      })
    ) {
      return false;
    }
    ruleCount += 1;
  }
  return ruleCount > 0;
}

export function renderCustomerCodeowners(input: {
  readonly source: string;
  readonly codeowner: string;
  readonly repository: string;
}): string {
  const codeowner = CODEOWNER_PATTERN.exec(input.codeowner);
  const repository = REPOSITORY_PATTERN.exec(input.repository);
  if (codeowner === null || repository === null) {
    throw new TypeError(
      "customer code owner and repository must use canonical GitHub names"
    );
  }
  if (
    codeowner[2] !== undefined &&
    codeowner[1]!.toLowerCase() !== repository[1]!.toLowerCase()
  ) {
    throw new TypeError(
      "customer code-owner team must belong to the repository owner"
    );
  }

  let ruleCount = 0;
  const rendered = input.source.split(/\r?\n/u).map((line) => {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      return line;
    }
    const fields = trimmed.split(/\s+/u);
    if (
      fields.length < 2 ||
      fields[0] === undefined ||
      fields.slice(1).some((field) => !field.startsWith("@"))
    ) {
      throw new TypeError("source CODEOWNERS contains an invalid rule");
    }
    ruleCount += 1;
    return `${fields[0]} ${input.codeowner}`;
  });
  if (ruleCount === 0) {
    throw new TypeError("source CODEOWNERS contains no ownership rules");
  }
  return rendered.join("\n");
}
