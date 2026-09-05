import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const families = ["memory", "skill", "knowledge", "none"];

const subjects = {
  memory: {
    dev: ["上次确定的发布窗口", "我偏好的测试框架", "之前讨论的回滚方案", "我的代码审查习惯", "我们约定的分支命名", "上周定位的超时原因", "我不允许使用的依赖", "之前保存的数据库参数", "我们讨论过的重试策略", "我的团队身份"],
    test: ["去年定下的兼容范围", "我常用的提交格式", "此前的容量结论", "我的日志脱敏偏好", "前一次迁移的风险", "我们过去采用的限流值", "我要求保留的接口行为", "早先排查出的根因", "之前确认的负责人", "我的开发环境习惯"],
  },
  skill: {
    dev: ["团队数据库发版流程", "仓库的依赖升级 SOP", "服务回滚检查清单", "项目规定的代码审查流程", "团队压测操作手册", "仓库安全扫描步骤", "线上故障复盘模板", "项目版本发布规范", "数据库迁移标准流程", "团队性能回归流程"],
    test: ["灰度验证标准操作", "仓库文档发布规程", "项目接口弃用流程", "团队依赖漏洞处置步骤", "服务扩容操作规程", "仓库基准测试规范", "团队应急演练流程", "项目变更审批步骤", "服务数据修复 SOP", "团队兼容性验收流程"],
  },
  knowledge: {
    dev: ["认证模块为何采用双令牌设计", "当前仓库的跨文件调用链", "存储层的历史架构决策", "本仓库会话模块的依赖关系", "团队对租户隔离的定义", "当前项目写路径的影响面", "缓存模块的设计权衡", "本仓库事件流的入口", "团队记录的迁移背景", "当前仓库符号间的调用关系"],
    test: ["限流模块为何使用令牌桶", "本仓库错误处理的跨层链路", "团队对数据归属的历史决定", "当前项目路由模块的结构", "设计文档里的审计边界", "本仓库删除接口的影响范围", "一致性机制的设计原因", "当前仓库任务调度的依赖图", "团队记录的兼容性取舍", "本项目初始化流程的调用关系"],
  },
  none: {
    dev: ["实现一个数组去重函数", "修复当前文件的类型错误", "解释 JavaScript 闭包", "为现有函数补单元测试", "重命名当前类的字段", "格式化这段 JSON", "分析给出的栈追踪", "实现二分查找", "优化眼前这段循环", "给当前接口加参数校验", "把 Python 函数改成异步", "解释 HTTP 404", "为本地模块添加日志", "修改 README 的错别字", "计算字符串哈希", "写一个 SQL 聚合查询", "给当前组件增加空状态", "解释 Git rebase", "删除未使用的 import", "为这段正则补注释"],
    test: ["实现 LRU 缓存类", "修复当前测试的断言", "解释 Rust 所有权", "为现有 API 写示例", "简化当前条件分支", "把 CSV 转成 JSON", "分析给出的编译错误", "实现拓扑排序", "优化当前 SQL 索引", "给函数增加边界检查", "把同步代码改成 Promise", "解释 HTTP 缓存头", "为本地命令增加参数", "更新当前注释的措辞", "计算两个集合的交集", "写一个窗口函数查询", "给页面增加加载状态", "解释 Git cherry-pick", "移除无效的配置项", "为解析器增加错误消息"],
  },
};

const prompts = {
  memory: [
    (s) => `请从我们的历史记录中找出${s}，确认后再回答。`,
    (s) => `我记不清${s}了，请查一下过去的记录。`,
  ],
  skill: [
    (s) => `请按${s}执行，不要自行发明步骤。`,
    (s) => `团队应该已有${s}，请找到并按它处理。`,
  ],
  knowledge: [
    (s) => `请查询团队知识资源，说明${s}。`,
    (s) => `需要跨文件或设计资料才能确认${s}，请先查知识库。`,
  ],
  none: [
    (s) => `${s}，直接使用当前输入和本地代码完成。`,
    (s) => `${s}；这里的 memory/skill/cache/knowledge 只是代码术语，不要查询云端资产。`,
  ],
};

function buildSplit(split) {
  const rows = [];
  for (const family of families) {
    const expectedCount = family === "none" ? 40 : 20;
    for (const [subjectIndex, subject] of subjects[family][split].entries()) {
      for (const [promptIndex, makePrompt] of prompts[family].entries()) {
        const ordinal = subjectIndex * prompts[family].length + promptIndex;
        rows.push({
          case_id: `${split}-${family}-${String(ordinal + 1).padStart(3, "0")}`,
          split,
          source: "synthetic",
          template_family: `${split}-${family}-${String(subjectIndex + 1).padStart(2, "0")}`,
          messages: [{ role: "user", content: makePrompt(subject) }],
          enabled_families: ["memory", "skill", "knowledge"],
          expected_family: family,
          reason: family === "none"
            ? "The request is answerable from the current input/workspace and must not call an asset tool."
            : `The answer explicitly requires the ${family} asset family.`,
        });
      }
    }
    const actual = rows.filter((row) => row.expected_family === family).length;
    if (actual !== expectedCount) throw new Error(`${split}/${family}: expected ${expectedCount}, got ${actual}`);
  }
  return rows;
}

await mkdir(here, { recursive: true });
for (const split of ["dev", "test"]) {
  const rows = buildSplit(split);
  if (rows.length !== 100) throw new Error(`${split}: expected 100, got ${rows.length}`);
  await writeFile(path.join(here, `proxy-${split}.jsonl`), `${rows.map(JSON.stringify).join("\n")}\n`, "utf8");
}

console.log("Generated proxy-dev.jsonl and proxy-test.jsonl (100 cases each).");
