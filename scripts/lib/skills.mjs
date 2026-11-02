import {execFile} from "node:child_process";
import {readdir, readFile, stat} from "node:fs/promises";
import {homedir} from "node:os";
import {join} from "node:path";
import {promisify} from "node:util";

const exec = promisify(execFile);

/**
 * 三个能力的接线层。
 *
 * 原则：**探测是真的，降级也是真的**。
 * - 每个 skill 的可用性由一次真实调用判定（跑它的 selfcheck 取退出码），不是「目录存在就算有」。
 * - 读不到就返回 unavailable 与原因，绝不返回空数组冒充「零候选」——
 *   那会让人以为市场没有机会，而事实是管线没接上。
 */

export const SKILL_NAMES = Object.freeze({
  selection: "crossborder-selection",
  upload: "crossborder-upload",
  modeling: "3d-booth-pipeline"
});

export function defaultSkillsRoot() {
  return join(homedir(), ".workbuddy", "skills");
}

export async function resolveSkillRoots({skillsRoot, config = {}}) {
  const base = skillsRoot ?? config.skills?.root ?? defaultSkillsRoot();
  const roots = {};
  for (const [key, name] of Object.entries(SKILL_NAMES)) {
    roots[key] = config.skills?.[`${key}Root`] ?? join(base, name);
  }
  return roots;
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * 探测一个 skill 是否真的可调用：跑它自己的自检脚本，只认退出码。
 * 0/1 都算「装好了」（1 通常是 WARN），ENOENT/非零高位算不可用。
 */
export async function probeSkill({root, script = "scripts/selfcheck.mjs", args = [], timeoutMs = 120_000}) {
  const target = join(root, script);
  if (!(await exists(target))) {
    return {ok: false, detail: `缺少 ${script}`, root, exitCode: null};
  }
  try {
    const {stdout, stderr} = await exec(process.execPath, [target, ...args], {
      cwd: root,
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true
    });
    return {ok: true, detail: "selfcheck 通过", root, exitCode: 0, stdout: stdout.slice(0, 2_000), stderr: stderr.slice(0, 500)};
  } catch (error) {
    const code = typeof error.code === "number" ? error.code : null;
    if (code === 0 || code === 1) {
      return {ok: true, detail: `selfcheck 退出码 ${code}（1 通常为 WARN）`, root, exitCode: code};
    }
    return {ok: false, detail: `selfcheck 失败：${error.message?.slice(0, 200) ?? "unknown"}`, root, exitCode: code};
  }
}

/**
 * 读取选品端的工单。这是三个 skill 之间**已经存在**的契约：
 * `kind=sourcing_ticket`，含真实货源链接、价格、克重、俄语信号与设计元素。
 * 我们只消费它，不重新实现采集。
 */
export async function loadTickets({selectionRoot, subdirs = ["data/export/sourcing", "data/export/ready"], limit = 200}) {
  const found = [];
  const missingDirs = [];
  for (const subdir of subdirs) {
    const dir = join(selectionRoot, subdir);
    let names;
    try {
      names = await readdir(dir);
    } catch (error) {
      if (error?.code === "ENOENT") {
        missingDirs.push(subdir);
        continue;
      }
      throw error;
    }
    for (const name of names.filter((item) => item.endsWith(".json") && !item.startsWith("_"))) {
      const file = join(dir, name);
      try {
        const ticket = JSON.parse(await readFile(file, "utf8"));
        // 两种形态都收：新版带 kind=sourcing_ticket；早期 ready 工单没有 kind，
        // 但只要有货源链接与名称，它仍然是可消费的工单 —— 拒收会让真实数据白丢。
        const isTicket = ticket?.kind === "sourcing_ticket";
        const isLegacyReady = !ticket?.kind && Boolean(ticket?.name) && ("offer_url" in ticket);
        if (!isTicket && !isLegacyReady) continue;
        found.push({
          ...ticket,
          kind: "sourcing_ticket",
          slug: ticket.slug ?? ticket.name,
          _file: `${subdir}/${name}`,
          _subdir: subdir,
          _schema: isTicket ? "sourcing_ticket" : "legacy_ready"
        });
      } catch {
        continue;
      }
    }
  }
  found.sort((left, right) => (right.trend_score ?? 0) - (left.trend_score ?? 0) || String(left.slug).localeCompare(String(right.slug)));
  return {
    tickets: found.slice(0, limit),
    total: found.length,
    missing_dirs: missingDirs,
    ready_count: found.filter((ticket) => ticket.offer_url && ticket.price_cny).length
  };
}

/** 参考图：真实 1688 照片目录。按别名表做保守匹配，匹配不到就不给。 */
export async function loadReferenceImages({uploadRoot, slug, keyword, aliases = null}) {
  const dir = join(uploadRoot, "1688-refs");
  let names;
  try {
    names = await readdir(dir);
  } catch (error) {
    if (error?.code === "ENOENT") return {images: [], detail: "1688-refs 目录不存在"};
    throw error;
  }
  const table = aliases ?? {};
  const raw = [slug, keyword].filter(Boolean).map((value) => String(value).toLowerCase());
  const latin = raw.flatMap((value) => value.split(/[\s\-_]+/)).filter((token) => token.length >= 3);
  const mapped = [];
  for (const [source, targets] of Object.entries(table)) {
    if (raw.some((value) => value.includes(source.toLowerCase()))) mapped.push(...targets);
  }
  const prefixes = [...new Set([...mapped, ...latin])]
    .map((prefix) => prefix.slice(0, 12))
    .filter((prefix) => prefix.length >= 3);

  const hits = names
    .filter((name) => /\.(?:jpe?g|png|webp)$/i.test(name))
    .filter((name) => {
      const lower = name.toLowerCase();
      return prefixes.some((prefix) => lower.includes(prefix));
    })
    .sort();

  return {
    images: hits.map((name) => join(dir, name)),
    detail: hits.length > 0 ? `命中 ${hits.length} 张（前缀：${prefixes.join("/")}）` : `无匹配前缀（试过：${prefixes.join("/") || "无"}）`
  };
}
