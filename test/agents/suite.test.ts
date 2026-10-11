import { adapters } from '../../src/agents/index.js';
import { describeAdapter } from './suite.js';

/**
 * 已注册的每个适配器都跑一遍公共套件（6 项表驱动断言）。
 * M5 扩到 16 个工具后，这里自动覆盖所有注册项，不用为新工具抄测试。
 * 各工具的特例（env 覆盖、多级 skills 目录、无 hook 的原因文案）在 test/agents/<id>.test.ts。
 */
for (const adapter of adapters) {
  describeAdapter(adapter);
}
