import * as fs from "fs";
import * as os from "os";
import { randomUUID } from "crypto";

import {
  logError,
  logInfo,
  logWarning,
  runCommand,
  sleep,
  waitForFile,
} from "../lib/common";
import { Config } from "../lib/config";
import { getGithubRunContext } from "../lib/github-context";
import { readJsonFile, removeFileIfExists, writeJsonFile } from "../lib/files";
import {
  fetchPolicyStoreConfig,
  handleBlockedRunPolicyEvaluation,
  PolicyStoreConfig,
} from "../lib/policy";

const POLICY_APPLIED_TIMEOUT_SECONDS = 10;

export async function runMacOSPreJobHook(): Promise<void> {
  const ctx = getGithubRunContext();
  const agentConfig = readAgentConfig(Config.macos.files.agentJson);
  if (agentConfig === "unreadable") {
    return;
  }
  const apiKey = readString(agentConfig, "api_key");
  if (!apiKey) {
    logWarning("API key is empty; skipping policy fetch");
    return;
  }

  const correlationId = randomUUID();
  logInfo(
    `Generated job correlationId for self-hosted agent: ${correlationId}`,
  );

  logInfo("PRE-JOB HOOK: Checking for policy from Policy Store...");

  const result = await fetchPolicyStoreConfig({
    owner: ctx.owner,
    repo: ctx.repo,
    workflow: ctx.workflow,
    runId: ctx.runId,
    correlationId,
    apiKey,
  });
  // logInfo(`Policy fetch result: ${JSON.stringify(result)}`);

  handleBlockedRunPolicyEvaluation(result.runPolicyEvaluation);
  clearPolicyApplicationFiles();

  if (result.status === "found" && result.config.policyName !== "") {
    logInfo(
      `Policy found, applying policy: ${result.config.policyName || "unnamed"}`,
    );
    writePolicyConfig(result.config, correlationId);
  } else if (result.status === "not_found") {
    logInfo("No policy configured from Policy Store");
    writePolicyConfig(
      {
        policyName: "",
        allowedEndpoints: "",
        deniedEndpoints: "",
        egressPolicy: "",
      },
      correlationId,
    );
    fs.writeFileSync(
      Config.macos.files.policyConfigCreated,
      "created",
      "utf8",
    );
    await sleep(2000);
    logInfo("PRE-JOB HOOK: Completed successfully");
    return;
  } else {
    logWarning("Policy fetch failed; skipping policy application");
    logInfo("PRE-JOB HOOK: Completed successfully");
    return;
  }

  fs.writeFileSync(Config.macos.files.policyConfigCreated, "created", "utf8");

  const applied = await waitForFile(
    Config.macos.files.policyApplied,
    POLICY_APPLIED_TIMEOUT_SECONDS,
    1000,
  );
  flushDnsCache();

  if (applied) {
    logInfo("policy enforced successfully");
  } else {
    logWarning(
      `Block mode policy enforcement timed out after ${POLICY_APPLIED_TIMEOUT_SECONDS}s; continuing`,
    );
  }

  logInfo("PRE-JOB HOOK: Completed successfully");
}

function clearPolicyApplicationFiles(): void {
  removeFileIfExists(Config.macos.files.policyConfig);
  removeFileIfExists(Config.macos.files.policyApplied);
  removeFileIfExists(Config.macos.files.policyConfigCreated);
}

function flushDnsCache(): void {
  logInfo("Flushing DNS cache with dscacheutil");
  const dscacheutilResult = runCommand("sudo", ["dscacheutil", "-flushcache"], {
    silent: true,
  });
  const mdnsResponderResult = runCommand(
    "sudo",
    ["killall", "-HUP", "mDNSResponder"],
    { silent: true },
  );

  if (dscacheutilResult.status !== 0 || mdnsResponderResult.status !== 0) {
    logWarning("Failed to flush DNS cache with dscacheutil");
  }
}

function writePolicyConfig(
  config: PolicyStoreConfig,
  correlationId: string,
): void {
  fs.mkdirSync(Config.macos.files.policyDataDir, { recursive: true });
  writeJsonFile(Config.macos.files.policyConfig, {
    correlation_id: correlationId,
    policy_name: config.policyName,
    allowed_endpoints: config.allowedEndpoints,
    denied_endpoints: config.deniedEndpoints,
    egress_policy: config.egressPolicy,
  });
}

// The installer writes agent.json as root, but the hooks run as the runner
// user. A permission error would otherwise read as an empty API key.
function readAgentConfig(
  filePath: string,
): Record<string, unknown> | null | "unreadable" {
  try {
    fs.accessSync(filePath, fs.constants.R_OK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EACCES" && code !== "EPERM") {
      return readJsonFile(filePath);
    }
    const user = os.userInfo().username;
    logError(
      `Cannot read ${filePath} as ${user} (${code}); skipping policy fetch. Grant the runner user read access, for example: sudo chown ${user} ${filePath}`,
    );
    return "unreadable";
  }
  return readJsonFile(filePath);
}

function readString(
  source: Record<string, unknown> | null,
  key: string,
): string {
  const value = source?.[key];
  return typeof value === "string" ? value : "";
}
