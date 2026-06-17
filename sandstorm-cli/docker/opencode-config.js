"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/main/opencode-config.ts
var opencode_config_exports = {};
__export(opencode_config_exports, {
  STATIC_INPUTS: () => STATIC_INPUTS,
  generateOpencodeConfig: () => generateOpencodeConfig,
  generateOuterOpencodeConfig: () => generateOuterOpencodeConfig
});
module.exports = __toCommonJS(opencode_config_exports);

// src/shared/opencode-providers.ts
function buildProviderEntry(providerId, bundle) {
  switch (providerId) {
    case "anthropic":
      return {
        providerKey: "anthropic",
        config: bundle.apiKey ? { apiKey: bundle.apiKey } : { apiKey: "{env:ANTHROPIC_API_KEY}" }
      };
    case "amazon-bedrock": {
      const options = {};
      if (bundle.region) options.region = bundle.region;
      if (bundle.bearerToken) {
        options.bearerToken = bundle.bearerToken;
      } else {
        if (bundle.accessKeyId) options.accessKeyId = bundle.accessKeyId;
        if (bundle.secretAccessKey) options.secretAccessKey = bundle.secretAccessKey;
        if (bundle.profile) options.profile = bundle.profile;
      }
      return {
        providerKey: "amazon-bedrock",
        config: Object.keys(options).length > 0 ? { options } : {}
      };
    }
    case "ollama":
      return {
        providerKey: "openai",
        config: {
          apiKey: "ollama",
          ...bundle.baseUrl ? { baseURL: bundle.baseUrl } : {}
        }
      };
    default:
      return {
        providerKey: providerId,
        config: bundle.apiKey ? { apiKey: bundle.apiKey } : { apiKey: `{env:${providerId.toUpperCase().replace(/-/g, "_")}_API_KEY}` }
      };
  }
}

// src/main/opencode-config.ts
var STATIC_INPUTS = {};
function generateOpencodeConfig(inputs = {}) {
  const providerId = inputs.providerId ?? "anthropic";
  const bundle = inputs.bundle ?? {};
  const { providerKey, config: providerConfig } = buildProviderEntry(providerId, bundle);
  return {
    model: inputs.model ?? "anthropic/claude-sonnet-4-6",
    provider: {
      [providerKey]: providerConfig
    },
    permission: "allow",
    instructions: ["/home/claude/.claude/CLAUDE.md"],
    mcp: {
      "chrome-devtools": {
        type: "local",
        // OpenCode flattens command+args into a single array; renames env→environment
        command: [
          "chrome-devtools-mcp",
          "--headless",
          "--no-usage-statistics",
          "--isolated",
          "--acceptInsecureCerts",
          "--executablePath",
          "/usr/bin/chromium",
          "--chromeArg=--no-sandbox",
          "--chromeArg=--disable-dev-shm-usage",
          "--chromeArg=--allow-insecure-localhost"
        ],
        environment: {
          CHROME_PATH: "/usr/bin/chromium",
          PUPPETEER_EXECUTABLE_PATH: "/usr/bin/chromium"
        }
      }
    }
  };
}
function generateOuterOpencodeConfig(inputs) {
  const shimMcpServer = {
    type: "local",
    command: [process.execPath, inputs.shimPath],
    environment: {
      SANDSTORM_BRIDGE_URL: inputs.bridgeUrl,
      SANDSTORM_BRIDGE_TOKEN: inputs.bridgeToken
    }
  };
  const providerId = inputs.providerId ?? "anthropic";
  const bundle = inputs.bundle ?? {};
  const { providerKey, config: providerConfig } = buildProviderEntry(providerId, bundle);
  return {
    model: inputs.model ?? "anthropic/claude-sonnet-4-6",
    provider: {
      [providerKey]: providerConfig
    },
    permission: "allow",
    instructions: [inputs.instructionsPath],
    mcp: {
      "sandstorm-bridge": shimMcpServer
    }
  };
}
if (require.main === module) {
  process.stdout.write(JSON.stringify(generateOpencodeConfig(STATIC_INPUTS), null, 2) + "\n");
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  STATIC_INPUTS,
  generateOpencodeConfig,
  generateOuterOpencodeConfig
});
