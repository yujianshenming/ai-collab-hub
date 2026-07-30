// safe-paths.js —— 主进程唯一路径边界事实源(纯模块,无 Electron 依赖,可直接单测)
//
// 设计原则:任何"路径是否落在某目录内 / 是否为某扩展名文件"的判断,必须先用
// fs.realpathSync 跟随 junction/symlink 解析到真实目标,再比对。严禁用
// path.resolve + 字符串 startsWith 做包含判断 —— 那会放过 Windows junction 逃逸。
//
// 这是对抗评审(ADVERSARIAL_REVIEW_2026-07-24)残留风险 #3 的修复,也是把"每个 bug
// 各打补丁"收敛为"单一可复用安全原语"的范式落地:resolveTaskPath 与
// resolveConfiguredPathCandidate 统一走这里,不再各写一份 realpath 逻辑。

const fs = require("node:fs");
const path = require("node:path");

/**
 * 统一真实路径守卫。
 * @param {string|null} baseDir 允许根目录;为 null 表示不限制目录(仅做 realpath + 扩展名校验)
 * @param {string} candidate 待校验路径
 * @param {{extensions?: string[]}} [opts] extensions: 允许的扩展名小写数组(含点,如 [".txt"])
 * @returns {string|null} 校验通过返回真实绝对路径,否则返回 null(fail-closed)
 */
function resolveContained(baseDir, candidate, { extensions } = {}) {
  const raw = String(candidate || "").trim();
  if (!raw) return null;

  let resolved;
  try {
    resolved = fs.realpathSync(raw); // 跟随 junction/symlink 到真实目标
  } catch {
    return null; // 不存在或不可达 → 拒绝
  }

  if (Array.isArray(extensions) && extensions.length) {
    if (!extensions.includes(path.extname(resolved).toLowerCase())) return null;
  }

  if (baseDir == null) return resolved; // 不限制目录

  let normalizedRoot;
  try {
    normalizedRoot = fs.realpathSync(baseDir);
  } catch {
    normalizedRoot = path.resolve(baseDir); // root 自身不存在时退化为普通解析,仍比对
  }
  if (resolved !== normalizedRoot && !resolved.startsWith(`${normalizedRoot}${path.sep}`)) {
    return null; // 越界(含 junction 逃逸)→ 拒绝
  }
  return resolved;
}

module.exports = { resolveContained };
