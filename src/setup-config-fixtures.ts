import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CONFIG } from "./config.js";
import {
  applyInitialSetup,
  describeDetectedAccount,
  getSetupStatus,
  resolveDetectedAccount,
  validateSetup,
} from "./setup-config.js";

assert.equal(getSetupStatus().complete, false);

const account = resolveDetectedAccount([
  {
    displayName: "Fixture Operator",
    uid: "1234567890123456789",
    secUid: "MS4wLjABAAAA_fixture_operator_001",
    source: "localStorage:userInfo",
    pageUrl: "https://creator.douyin.com/creator-micro/home",
  },
]);
const publicAccount = describeDetectedAccount(account);
assert.equal(publicAccount.displayName, "Fixture Operator");
assert.equal(JSON.stringify(publicAccount).includes(account.uid), false);
assert.equal(JSON.stringify(publicAccount).includes(account.secUid), false);

assert.throws(() => resolveDetectedAccount([
  {
    displayName: "Fixture Operator",
    uid: "1234567890123456789",
    secUid: "MS4wLjABAAAA_fixture_operator_001",
    source: "one",
  },
  {
    displayName: "Different Operator",
    uid: "9876543210987654321",
    secUid: "MS4wLjABAAAA_fixture_operator_002",
    source: "two",
  },
]), /SETUP_ACCOUNT_CONFLICT/);

const applied = await applyInitialSetup(account, {
  operatorAlias: "operator",
  publicComment: false,
  commentReply: false,
  publishVideo: false,
  publishArticle: false,
  maxWritesPerMinute: 4,
  shareCooldownMinutes: 10,
  minDelayMs: 900,
  maxDelayMs: 1_600,
});
assert.equal(applied.applied, true);
assert.equal(JSON.stringify(applied).includes(account.uid), false);
assert.equal(JSON.stringify(applied).includes(account.secUid), false);
assert.equal(getSetupStatus().complete, true);
assert.equal(getSetupStatus().operator?.alias, "operator");
assert.equal(validateSetup().valid, true);

for (const fileName of [
  "douyin_action_settings.json",
  "douyin_bound_users.json",
  "douyin_social_actions.json",
]) {
  assert.equal(fs.existsSync(path.join(CONFIG.privateConfigDir, fileName)), true);
}

await assert.rejects(() => applyInitialSetup(account, {
  operatorAlias: "operator",
  publicComment: false,
  commentReply: false,
  publishVideo: false,
  publishArticle: false,
  maxWritesPerMinute: 4,
  shareCooldownMinutes: 10,
  minDelayMs: 900,
  maxDelayMs: 1_600,
}), /SETUP_EXISTING_CONFIG_REFUSED/);

console.log("setup config fixtures: ok");
