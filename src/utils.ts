import { ButtonComponent, Setting } from "obsidian";
import type { DkgClient } from "./dkgClient";

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runConnectionTest(
  client: DkgClient,
  statusSetting: Setting,
  testBtn: ButtonComponent,
  skipIdentityCheck = false
): Promise<boolean> {
  testBtn.setButtonText("Testing...");
  testBtn.setDisabled(true);
  statusSetting.setDesc("Connecting...");
  statusSetting.descEl.style.color = "var(--text-muted)";

  let nodeOk = false;
  try {
    await client.status();
    nodeOk = true;
    if (skipIdentityCheck) {
      statusSetting.setDesc("Connected — node reachable (no auth token configured)");
    } else {
      await client.getIdentity();
      statusSetting.setDesc("Connected — node reachable, identity verified");
    }
    statusSetting.descEl.style.color = "var(--color-green)";
    return true;
  } catch (err) {
    console.error("[DKG] connection test failed:", err);
    statusSetting.setDesc(
      nodeOk
        ? "Node reachable but identity check failed — check your auth token"
        : "Could not reach node — check the URL and that your node is running"
    );
    statusSetting.descEl.style.color = "var(--color-red)";
    return false;
  } finally {
    testBtn.setButtonText("Test");
    testBtn.setDisabled(false);
  }
}
