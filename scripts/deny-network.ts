import { createRequire, syncBuiltinESMExports } from "node:module";

const NETWORK_DENIAL = "SYNTHETIC_CANARY_NETWORK_DENIED";

function denyNetwork(): never {
  throw new Error(NETWORK_DENIAL);
}

function replace(moduleName: string, names: readonly string[]): void {
  const loaded = createRequire(import.meta.url)(moduleName) as object;
  for (const name of names) {
    if (!Reflect.set(loaded, name, denyNetwork)) {
      throw new TypeError(`cannot deny ${moduleName}.${name}`);
    }
  }
}

function replacePrototype(
  moduleName: string,
  constructorName: string,
  methodName: string
): void {
  const loaded = createRequire(import.meta.url)(moduleName) as object;
  const constructor = Reflect.get(loaded, constructorName) as
    | { readonly prototype?: object }
    | undefined;
  if (
    constructor?.prototype === undefined ||
    !Reflect.set(constructor.prototype, methodName, denyNetwork)
  ) {
    throw new TypeError(
      `cannot deny ${moduleName}.${constructorName}.prototype.${methodName}`
    );
  }
}

replace("node:http", ["get", "request"]);
replace("node:https", ["get", "request"]);
replace("node:http2", ["connect"]);
replace("node:net", ["connect", "createConnection"]);
replace("node:tls", ["connect"]);
replace("node:dgram", ["createSocket"]);
replace("node:dns", [
  "lookup",
  "resolve",
  "resolve4",
  "resolve6",
  "resolveAny",
  "resolveCaa",
  "resolveCname",
  "resolveMx",
  "resolveNaptr",
  "resolveNs",
  "resolvePtr",
  "resolveSoa",
  "resolveSrv",
  "resolveTxt",
  "reverse"
]);
replace("node:dns/promises", [
  "lookup",
  "resolve",
  "resolve4",
  "resolve6",
  "resolveAny",
  "resolveCaa",
  "resolveCname",
  "resolveMx",
  "resolveNaptr",
  "resolveNs",
  "resolvePtr",
  "resolveSoa",
  "resolveSrv",
  "resolveTxt",
  "reverse"
]);
replacePrototype("node:net", "Socket", "connect");
replacePrototype("node:net", "Server", "listen");
replacePrototype("node:tls", "TLSSocket", "connect");
syncBuiltinESMExports();

Object.defineProperty(globalThis, "fetch", {
  configurable: false,
  enumerable: true,
  value: denyNetwork,
  writable: false
});

if ("WebSocket" in globalThis) {
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: false,
    enumerable: true,
    value: class DeniedWebSocket {
      constructor() {
        denyNetwork();
      }
    },
    writable: false
  });
}

if ("EventSource" in globalThis) {
  Object.defineProperty(globalThis, "EventSource", {
    configurable: false,
    enumerable: true,
    value: class DeniedEventSource {
      constructor() {
        denyNetwork();
      }
    },
    writable: false
  });
}
