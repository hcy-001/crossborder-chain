import {createHash} from "node:crypto";
import {mkdir, readdir, readFile, writeFile} from "node:fs/promises";
import {join} from "node:path";

const pretty = (value) => `${JSON.stringify(value, null, 2)}\n`;

export function sha256(value) {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}

/**
 * 判别台账。
 *
 * 存在的唯一理由是：LLM 参与决策之后，「为什么这么定」不能只活在对话里。
 * 每条记录都包含 prompt 哈希、原始返回、解析结果、schema 结论、冲突项、
 * 最终是否采用、用了哪条回退 —— 少任何一项，事后就无法复盘是谁改变了结论。
 */
export function createJournal({dir}) {
  if (!dir) throw new Error("journal dir is required");
  const entries = [];

  return {
    dir,

    async write(entry) {
      await mkdir(dir, {recursive: true});
      const name = `${entry.point}--${entry.scope ?? "default"}.json`;
      const record = {...entry, prompt_sha256: entry.prompt_sha256 ?? null};
      await writeFile(join(dir, name), pretty(record));
      entries.push({...record, file: name});
      return join(dir, name);
    },

    entries() {
      return entries.map((entry) => ({...entry}));
    },

    /** 汇总：给回执用的最小信息，不把整份 prompt 塞进回执。 */
    summary() {
      const bySource = entries.reduce((acc, entry) => {
        acc[entry.source] = (acc[entry.source] ?? 0) + 1;
        return acc;
      }, {});
      return {
        total: entries.length,
        by_source: bySource,
        rejected: entries.filter((entry) => entry.source === "fallback").map((entry) => ({
          point: entry.point,
          scope: entry.scope,
          reason: entry.reject_reason ?? null,
          conflicts: (entry.conflicts ?? []).map((item) => item.code)
        })),
        usage: entries.reduce((acc, entry) => {
          const usage = entry.usage ?? {};
          acc.prompt_tokens += Number(usage.prompt_tokens ?? 0);
          acc.completion_tokens += Number(usage.completion_tokens ?? 0);
          acc.total_tokens += Number(usage.total_tokens ?? 0);
          return acc;
        }, {prompt_tokens: 0, completion_tokens: 0, total_tokens: 0})
      };
    }
  };
}

/** 读回一轮已经落盘的判别记录，用于复盘与一致性测试。 */
export async function readJournal(dir) {
  let names;
  try {
    names = await readdir(dir);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const out = [];
  for (const name of names.filter((item) => item.endsWith(".json")).sort()) {
    out.push(JSON.parse(await readFile(join(dir, name), "utf8")));
  }
  return out;
}
