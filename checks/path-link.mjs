// 创建"真的可解析"的目录链接的共享工具。
//
// 为什么这必须共享而不是各写一份：一个**长得像链接、但解析不到目标**的条目（Windows 上
// `fs.realpathSync` 跟不动 junction、macOS/Windows runner 上建符号链接被拒后留下的普通目录）
// 会让"两种拼写判成同一个身份"这类断言**在什么都没验证的情况下通过**。
// 本仓库已经栽过一次同类跟头：断言在"环境不支持"时保持了绿色。
//
// 因此判据是**能力探测**：建出来的东西必须能被 `realpathSync.native` 解析到别处，否则一律
// 视为"本环境做不到"，由调用方显式跳过并说明原因。
import { realpathSync, rmSync, symlinkSync } from 'node:fs'

const IS_WINDOWS = process.platform === 'win32'

/**
 * 建一个目录链接，并确认它**真的指向别处**。
 *
 * Windows 优先 junction（免提权），失败再试目录符号链接（需要 Developer Mode）；
 * POSIX 只有符号链接。解析不到目标的残留一律清掉，不在磁盘上留垃圾。
 *
 * @param {string} target - 链接应指向的目录（必须存在）。
 * @param {string} linkPath - 链接自身的路径（必须不存在）。
 * @returns {boolean} 是否已存在一个可解析的链接。
 */
export function linkThatResolves(target, linkPath) {
  const attempt = (type) => {
    try {
      symlinkSync(target, linkPath, type)
      return true
    } catch {
      return false
    }
  }

  for (const type of IS_WINDOWS ? ['junction', 'dir'] : ['dir']) {
    // 上一次尝试留下的条目会让下一次报 EEXIST。
    rmSync(linkPath, { recursive: true, force: true })
    if (!attempt(type)) continue
    try {
      // 两个条件都要：解析结果既不能等于链接自身（否则这是个普通目录），
      // 又必须等于目标（否则指向了别处）。
      if (realpathSync.native(linkPath) !== linkPath && realpathSync.native(linkPath) === realpathSync.native(target)) return true
    } catch {
      // 解析不到：试下一种类型。
    }
  }
  rmSync(linkPath, { recursive: true, force: true })
  return false
}

/**
 * 判断某个路径当前是否是一个**可解析**的目录链接。
 *
 * @param {string} linkPath - 待检查的路径。
 * @returns {boolean} 是否可解析到别处。
 */
export function resolvesElsewhere(linkPath) {
  try {
    return realpathSync.native(linkPath) !== linkPath
  } catch {
    return false
  }
}
