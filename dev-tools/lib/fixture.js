'use strict';
/**
 * **平台 / 材料准备的公共实现**（三个服务器测试各抄了一份，坑也就各踩一遍）。
 *
 * 抽出来的理由 —— 这些坑**每一个都害过好几轮**：
 *   · `/fill` 一次最多 32768 块 → 超了**整条被拒、什么都不做**，
 *     现象却是「她站在天然地上挖泥土」（看起来像功能坏了）
 *   · 平台底层没基岩 → 她挖穿 -64 掉进虚空摔死，
 *     现象是「盖房被取消、背包空了」（看起来像盖房失败）
 *   · 平台太小（33×33）→ 她盖房时掉下去摔死（现象同上）
 *   · 盖房材料不给 → 盖房超时（表现像超时，根因是没门/没煤）
 *
 * 放到这里之后：**修一次，三个测试同时受益**；而且注释里记的坑只有一份。
 *
 * 另带 `assertBlockAt`：setup 完验证目标状态 ——
 * 消息断言（rcon 严格模式）是第一道网，**读方块确认是第二道网**，
 * 因为**还没实测过的拒绝文案会原样返回**（见 lib/rcon.js 的说明）。
 */

/** 分片填：单片块数必须 < 32768（/fill 上限，实测超限整条被拒）。 */
async function fillSliced(rcon, { x1, z1, x2, z2, y1, y2, block, sliceW = 8 }) {
  const name = String(block).includes(':') ? block : `minecraft:${block}`;
  for (let fx = x1; fx <= x2; fx += sliceW) {
    await rcon.command(
      `fill ${fx} ${y1} ${z1} ${Math.min(fx + sliceW - 1, x2)} ${y2} ${z2} ${name}`,
    );
  }
}

/** 圈 forceload（范围比平台各大一圈，保证边缘区块也加载）。 */
async function forceloadArea(rcon, x1, z1, x2, z2) {
  await rcon.command(`forceload add ${x1} ${z1} ${x2} ${z2}`);
}

/**
 * 空中石台：石头 [-64, stoneTop]、air (stoneTop, clearTop]、**底层基岩**。
 * 默认 81×81（half=40 —— 33×33 实测太小，她会掉下去摔死）。
 */
async function buildPlatform(rcon, { x, z, half = 40, stoneTop = -40, clearTop = -20 }) {
  await forceloadArea(rcon, x - half - 8, z - half - 8, x + half + 8, z + half + 8);
  const base = { x1: x - half, z1: z - half, x2: x + half, z2: z + half };
  await fillSliced(rcon, { ...base, y1: -64, y2: stoneTop, block: 'stone' });
  await fillSliced(rcon, { ...base, y1: stoneTop + 1, y2: clearTop, block: 'air' });
  // 底层基岩：防「挖穿 -64 掉虚空」（挖矿测试必须有）
  await fillSliced(rcon, { ...base, y1: -64, y2: -64, block: 'bedrock' });
}

/** 给她东西（setup 材料）。 */
async function give(rcon, user, item, count) {
  await rcon.command(`give ${user} ${item} ${count}`);
}

/**
 * setup 后验证某格是什么方块 —— 不符**直接抛**（快速失败 + 打印实测值）。
 *
 * **走引擎的 `block.at` RPC，不走 RCON** —— 试过两条 RCON 路都不行：
 *   · `block x y z`        → vanilla **没有**这个命令（Unknown command）
 *   · `data get block ...` → 只对**方块实体**有效（"The target block is not a
 *     block entity"，石头不是实体）
 * `block.at` 是引擎自己的客户端方块查询，minetest 里实测在用、返回 `{name}`。
 *
 * @param call 引擎 RPC 调用函数（`(...args) => client.call(...args)`）
 */
async function assertBlockAt(call, x, y, z, expect) {
  const b = await call('block.at', { x, y, z });
  const name = b && b.name;
  if (name !== expect) {
    throw new Error(
      `setup 校验失败（快速失败，不许带假前提继续跑）：(${x},${y},${z}) 应是「${expect}」，实际：${name || JSON.stringify(b) || '(读不到)'}`,
    );
  }
}

module.exports = { fillSliced, forceloadArea, buildPlatform, give, assertBlockAt };
