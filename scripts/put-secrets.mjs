// Cloudflare 빌드에서만 실행: 빌드용 비밀 값(IG_TOKEN, APP_SECRET, VERIFY_TOKEN)을 Worker 실행용 비밀 값으로 옮김.
// 값은 출력하지 않고, 임시 파일은 바로 지움. (2026-11-26)
import { writeFileSync, unlinkSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const names = ["IG_TOKEN", "APP_SECRET", "VERIFY_TOKEN"];
const vals = Object.fromEntries(names.filter((n) => process.env[n]).map((n) => [n, process.env[n]]));
const missing = names.filter((n) => !vals[n]);
console.log(`put-secrets: 있음 ${Object.keys(vals).join(",") || "없음"} / 없음 ${missing.join(",") || "없음"}`);
if (!Object.keys(vals).length) process.exit(0);
const f = join(tmpdir(), `secrets-${Date.now()}.json`);
writeFileSync(f, JSON.stringify(vals), { mode: 0o600 });
try {
  execSync(`npx wrangler secret bulk "${f}"`, { stdio: ["ignore", "ignore", "inherit"] });
  console.log("put-secrets: 실행용 비밀 값 반영 완료");
} finally {
  try { unlinkSync(f); } catch {}
}
