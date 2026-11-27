import { z } from 'zod';
// 2026-11-14: lodash 是 webpack externals 注入的全局（webpack.config.ts:4），不在 auto-imports 里 ——
// 一旦把 no-undef 开成 error 就会报悬空，所以显式写出来（default 形式，与 设置.ts 一致）。
import _ from 'lodash';

/** 一套完整的接口配置(当前配置与预设共用同一结构) */
export const ApiConfigSchema = z
  .object({
    地址: z.string().default(''),
    密钥: z.string().default(''),
    模型: z.string().default(''),
    模型列表: z.array(z.string()).default([]),
    // 转发开关已删除: 转发是唯一通路(浏览器直连那条支路已在 api.ts 里删掉),
    // 老设置里残留的同名字段由 zod 忽略, 不会报错。
    /** 流式输出: 交给酒馆服务器转发时对应 should_stream, 上游边生成边返回 */
    流式: z.boolean().default(false),
    温度: z.coerce
      .number()
      .default(0.8)
      .transform(value => _.clamp(value, 0, 2)),
    最大token: z.coerce
      .number()
      .default(60000)
      .transform(value => Math.max(1, Math.min(131072, Math.round(value)))),
  })
  .prefault({});
export type ApiConfig = z.infer<typeof ApiConfigSchema>;

export const SettingsSchema = z
  .object({
    /** 启用世界运转: 关闭后不再调用 API、不再自动推进, 已有世界数据保留(重开恢复) */
    启用运转: z.boolean().default(true),
    接口: ApiConfigSchema,
    /** 保存的多套接口配置预设(名字 → 完整接口配置), 用于快速切换不同 AI */
    接口预设: z.record(z.string(), ApiConfigSchema).default({}),
    运转: z
      .object({
        自动更新: z.boolean().default(true),
        /** 每 N 条 AI 回复推进一次世界(1=每次都推进) */
        更新频率: z.coerce
          .number()
          .default(1)
          .transform(value => Math.max(1, Math.round(value))),
        /** 自动推进最短正文字数(0~5000, 默认 200; 0=不限制): 过滤标签后低于该字数疑似截断/极短回复, 跳过自动推进 */
        自动推进最短字数: z.coerce
          .number()
          .default(200)
          .transform(value => Math.max(0, Math.min(5000, Math.round(value)))),
        /** 楼层快照保留份数: 世界状态随推进楼层保留最近 N 份(删楼=回退到更早快照, 窗口耗尽世界归零)。调大删楼回退更远更保险, 但每份几KB~30KB, 聊天文件随之变大 */
        快照保留份数: z.coerce
          .number()
          .default(10)
          .transform(value => Math.max(1, Math.min(100, Math.round(value)))),
        /** 世界推进时读取最近 N 条 AI 回复 */
        读取最近回复数: z.coerce
          .number()
          .default(3)
          .transform(value => Math.max(1, Math.min(20, Math.round(value)))),
        /** 把世界动向写入世界书的常驻条目(蓝灯常开), 主 AI 与彼方每回合都能读到 */
        注入世界书条目: z.boolean().default(true),
        /** 拆分绿灯条目: 把未进简报的组织与非所在地地区写成关键词触发的绿灯条目(平时 0 token) */
        拆分绿灯条目: z.boolean().default(true),
        /** 写入目标世界书: 单聊默认角色卡主世界书; 群聊或想每场聊天完全隔离时选「聊天世界书」 */
        世界书写入目标: z.enum(['角色卡主世界书', '聊天世界书']).default('角色卡主世界书'),
        // 2026-11-22 删除 迫近闯入(@deprecated, 引擎早已不用): z.object 解析时会丢掉旧设置里残留的这个键, 不报错
        /** 保密事件注入主 AI: 默认关闭(保密事件只进面板供烟火推演); 开启后以"主角绝不可能知道"的标注注入。v2.10.1 前键名是 注入隐秘事件(不迁移) */
        注入保密事件: z.boolean().default(false),
        /** 传播时滞(v2.9.2)总开关: 开着时, 远方的公开事件按「传讯速度」与传播等级晚几日才进注入。
         *  真正生效还要本聊天选了传讯速度(按聊天存在聊天变量里, 不在这份全局设置里)、主角所在已知、世界时间可解析;
         *  任一不满足就按 v2.9.1 的规则注入(不按到达过滤)。 */
        传播时滞: z.boolean().default(true),
        /** 到期掷骰(v2.9.3): 事件到了「下次判定时间」时由脚本掷出 推进/僵持/受挫, 模型按结果展开这一步。
         *  关掉 = 不掷、不强制进工作集, 到期事件按以前的方式交给模型自己判断。 */
        到期掷骰: z.boolean().default(true),
        /** 联动彼方幕后人物(双向联动·方案B): 只读彼方楼层快照里的身份/位置/当前在做/当前目标/藏起来的打算/进行中事务,
         *  彻底过滤恋爱/生理/起居等私生活; 未安装彼方或本聊天无数据时静默跳过。 */
        联动彼方: z.boolean().default(true),
        /** 形势层: 世界层面正在流动的大趋势(战云/商路/教派/新政/灾荒)(默认开); 关掉后保留旧档案但不再发给模型维护 */
        世界形势: z.boolean().default(true),
        /** 日程层: 按世界观生成节日/汛期/开市/检阅等周期性临近节点(默认开)。v2.10.1 前键名是 节令历法(旧设置里的值不迁移, 回到默认) */
        世界日程: z.boolean().default(true),
        /** 世界指标层: 少量慢变数值(丰歉/物价/能源/民心等, 按世界观取名), 事件推动它们、它们反过来生事件(默认开) */
        世界指标: z.boolean().default(true),
        /** 运转密度: 控制每轮新增事件上限与"静止"的默认强度。稀疏=允许长时间零新增; 正常=主动找、找不到才静止; 密集=每轮尽量都有产出。
         *  只影响配额与措辞, **不影响事件合格线与世界观标尺**。 */
        世界密度: z.enum(['稀疏', '正常', '密集']).default('正常'),
        /** 不填时跟随密度；调整的是整件事的名额，绝不裁字段正文。 */
        每轮新增上限: z.coerce.number().int().min(0).max(30).optional(),
        大跳新增上限: z.coerce.number().int().min(0).max(30).optional(),
        重点跟进数: z.coerce.number().int().min(1).max(30).optional(),
        公开摘要条数: z.coerce.number().int().min(0).max(30).optional(),
        /** 字符计数而非伪装的token预算；必要完整条目超出目标只提醒。 */
        摘要目标字符: z.coerce.number().int().min(500).max(200000).optional(),
        /** 世界推进时读取世界书(与主 AI 相同的激活方式) */
        读取世界书: z.boolean().default(true),
        /** 读取世界书时是否包含全局世界书(默认只读角色卡主+附加与聊天世界书) */
        读取全局世界书: z.boolean().default(false),
        /** 读取世界书时排除的条目名(列表): 填条目名(或其关键词)即不读该条目 */
        世界书排除: z.array(z.string()).default([]),
        /** 预填充(prefill): 在最后追加一条 assistant 消息引导模型直接从 JSON 开始输出 */
        预填充: z.boolean().default(false),
        /** 失败重试次数(0~10, 默认 2 → 首次 + 最多重试 2 次 = 最多尝试 3 次) */
        重试次数: z.coerce
          .number()
          .default(2)
          .transform(value => Math.max(0, Math.min(10, Math.round(value)))),
        /** 自定义提示词(可选): 留空时零侵入, 非空时追加给世界引擎作为补充世界观与运转规则 */
        自定义提示词: z.string().default(''),
      })
      .prefault({}),
    /** 楼层标签过滤: 处理发给世界引擎的回复内容 */
    标签: z
      .object({
        模式: z.enum(['排除', '只读']).default('排除'),
        列表: z.array(z.string()).default(['aftertalk']),
      })
      .prefault({}),
  })
  .prefault({});
export type Settings = z.infer<typeof SettingsSchema>;

// ---------------------------------------------------------------------------
// 世界数据(存在楼层快照里, 与楼层共存亡)
// ---------------------------------------------------------------------------

// v2.10.0 取值换成通用词(古代卡也用这一套); 旧值在读档与读模型输出时经 迁移枚举值 换成新值, 见文件末尾 旧枚举值
export type 事件规模 = '一般' | '重大';
export type 事件传播 = '本地' | '区域' | '全域';
export type 事件阶段 = '酝酿' | '进行中' | '收尾' | '已结束';
export type 事件公开性 = '公开' | '保密';
export type 暗线成熟度 = '酝酿' | '临近' | '已发生' | '已失效';
export type 指标趋势 = '上升' | '下降' | '平稳';
/** 传讯速度(v2.9.2): 远方消息传到主角所在地要几个世界日。按聊天选, 不设默认 —— '未选' 时传播时滞不生效。 */
export type 传讯速度 = '未选' | '古代' | '近代' | '现代';
export const 传讯速度表: readonly 传讯速度[] = ['未选', '古代', '近代', '现代'];
export function 是传讯速度(值: unknown): 值 is 传讯速度 {
  return typeof 值 === 'string' && (传讯速度表 as readonly string[]).includes(值);
}

/** 一条事件演变记录: 每次实质推进追加一条(脚本端累积, 最新在后) */
export interface EventEvolution {
  /** 该次推进后的世界时间 */
  时间: string;
  /** 这一次推进发生了什么(一句话) */
  变化: string;
}

/** 一条世界事件(纪事条目)。事件是世界自身的公共层动态, 与主角无关 */
export interface WorldEvent {
  /** 事件唯一标识(脚本签发, AI 只需原样带回): 标题可能被 AI 改动, 对账先按 id 再按标题兜底, 靠 id 保住演变与背景 */
  id: string;
  标题: string;
  描述: string;
  地点: string;
  时间: string;
  规模: 事件规模;
  传播: 事件传播;
  渠道: string;
  组织: string;
  阶段: 事件阶段;
  /** 这件事是否各方秘而不宣: 保密=暗中行动, 不走公共渠道, 默认不注入主 AI(v2.10.1 前键名是 隐秘) */
  公开性: 事件公开性;
  /** 代表人物: 该事件中站在台前的 1~2 个具体人物(头衔+名字, 如"首席信息官·林素问"), 纯公共身份, 不写私人动态 */
  代表人物: string;
  /** 背景: 这件事的来龙去脉总结(含起因), AI 滚动维护——每次推进把本次变化折进上一次背景 */
  背景: string;
  /** 演变流水(脚本端累积, 最新在后): 面板的精确轨迹, AI 整体替换事件清单也吞不掉 */
  演变: EventEvolution[];
  /** 状态变化的依据与等待条件；不按调用轮数强行结束。 */
  结束原因?: string;
  等待条件?: string;
  下次判定时间?: string;
  /** 到期判定(v2.9.3): **只由脚本写**, 与 id / 演变 同类 —— 不进事件层字段、不进事件 JSON 示例、不进注入。
   *  到期 = 掷骰时对应的「下次判定时间」; 模型本轮没展开这一步时留着, 下一轮沿用同一结果(不重掷)。 */
  判定?: 到期判定;
}

export type 判定结果 = '推进' | '僵持' | '受挫';
export const 判定结果表: readonly 判定结果[] = ['推进', '僵持', '受挫'];
export interface 到期判定 {
  到期: string;
  结果: 判定结果;
}

/** 一个组织的当前盘算(有自主目标、持续行动、能影响事件走向的集体) */
export interface WorldFaction {
  目标: string;
  动向: string;
  /** 背景: 该组织的来龙去脉滚动总结(怎么起家/为何有此目标), AI 每轮把新变化折进旧背景带回 */
  背景: string;
  /** 覆盖范围: 地盘与影响的复合描述——传统组织写地盘("北境三城"), 影响力型组织写主导的行业/阶层/渠道("好莱坞六大制片厂主导"), 兼有则都写 */
  覆盖范围: string;
  /** 外部关系: 与其他组织的当前关系(如"与X商团盟约渐固; 与Y帮派摩擦升级"), 逐条一句话 */
  外部关系: string;
  /** 负责人: 它的首领/掌门/代言人(头衔+名字, 如"家主·林远山"), 主 AI 写戏时知道谁出面; 慢变字段 */
  负责人: string;
}

/** 已解体/消亡的组织归档(破产/解散/覆灭/兼并): 从活跃组织移出腾出名额, 完整保留历史原因与背景 */
export interface WorldArchivedFaction extends WorldFaction {
  名称: string;
  解体时间?: string;
  结束原因?: string;
}

/** 地区: 城市/地区/星区/国度等常驻实体, 事件的地理来源 */
export interface WorldRegion {
  /** 概况: 地理、物产、风貌(慢变) */
  概况: string;
  /** 局势: 当前局势与民生(可每轮推进) */
  局势: string;
  /** 主事方: 治理者或主导组织 */
  主事方: string;
  /** 外部关系: 与周边地区/组织的关系 */
  外部关系: string;
  /** 邻近地区(可选): 显式连通的邻近地区名列表(顿号/逗号分隔), 优先于外部关系文本匹配 */
  邻近地区?: string;
  /** 背景: 演变因果(怎么走到今天), 不复述概况 */
  背景: string;
}

/** 形势: 世界层面正在流动的大趋势(战云/商路/教派/新政/灾荒), 会自己推进并催生事件 */
export interface WorldTrend {
  /** 概况: 这股形势是什么 */
  概况: string;
  /** 进展: 当前推进到哪一步 */
  进展: string;
  /** 走向: 可能导向什么 */
  走向: string;
  /** 背景: 演变因果(怎么走到今天), 不复述概况 */
  背景: string;
}

/** 已平息/终结的形势归档: 从活跃形势移出腾出名额, 完整保留历史原因与背景 */
export interface WorldArchivedTrend extends WorldTrend {
  名称: string;
  平息时间?: string;
  结束原因?: string;
}

/** 暗线: 埋下的长期线头, 跨回合成熟后爆发为事件 */
export interface WorldSeed {
  标题: string;
  /** 线索: 埋下的前提/线头 */
  线索: string;
  /** 指向: 成熟时可能导向什么 */
  指向: string;
  成熟度: 暗线成熟度;
  /** 背景: 演变因果(怎么走到今天), 不复述概况 */
  背景: string;
  /** 终止依据(已发生/已失效时完整保留，不裁切) */
  结束原因?: string;
}

/** 日程: 按世界观生成的周期性或临近的公共事件节点(节庆/汛期/开市/检阅/换届) */
export interface WorldOccasion {
  名称: string;
  /** 周期: 每年/每季/每月/一次性 等 */
  周期: string;
  /** 时间: 下次发生时间(与"世界.时间"同格式) */
  时间: string;
  /** 概况: 这是什么 */
  概况: string;
  /** 范围(v2.9.5): 所属地区名, 空 = 全境 */
  范围?: string;
}

/** 世界指标: 少量慢变数值, 事件推动它们、它们反过来生事件 */
export interface WorldMetric {
  /** 值: 数值或档位(按世界观) */
  值: string;
  趋势: 指标趋势;
  说明: string;
  /** 范围(v2.9.5): 所属地区名, 空 = 全境 */
  范围?: string;
}

export interface WorldInfo {
  时间: string;
  氛围: string;
  /** 总览: 一两句世界总体走向(原「形势」, 与结构化「形势」层区分) */
  总览: string;
  /** 主角此刻所在的地区名(v2.9.1)。模型按最新正文填, 脚本按「地区名 → 包含匹配 → 照用 → 沿用 → 正文里找」核对。
   *  缺失/空 = 未知: 注入不判"本地"(全部事件保留背景、不出【所在地】段)。可选键, 旧快照读回不多出它。
   *  它只是主 AI 写戏时的位置参照, 不是"世界围着主角转"的依据 —— 事件素材仍从五层长出来。 */
  主角所在?: string;
}

export interface WorldStats {
  /**
   * 成功提交的推进轮数: `update.ts` 提交快照时 +1(随楼层快照回退)。
   * 用途只有两个 —— 面板显示「已推进 N 次」, 以及 `选工作事件` 的轮换起点。
   * 判断"推进到哪个楼层了"仍看 `处理到楼层` / `锚点楼层`, 别拿它当楼层进度。
   * (2026-10-11 v2.8.5 时它确实是死字段、恒为 0; 之后 update.ts 接上了自增, 这条注释 2026-11-22 更正。)
   */
  推进次数: number;
  最后推进: number;
  /** 节奏事实(v2.9.3): 上次出现重大事件 / 上次新增公共事态时的世界时间。提交快照时由脚本维护;
   *  只在有值时才写这个键(旧快照形状不变)。缺失时请求里按 事件 + 已结束 反推一次。
   *  它只作为事实写进请求, 不是额度, 不催产。
   *  键名统一: v2.10.1 前叫 `上次大事时间`, 读旧快照时回落到它。 */
  上次重大事件时间?: string;
  上次新增时间?: string;
}

/** 世界状态本体(整体写入楼层快照, 随楼层存亡) */
export interface WorldData {
  版本: number;
  世界: WorldInfo;
  地区: Record<string, WorldRegion>;
  形势: Record<string, WorldTrend>;
  暗线: WorldSeed[];
  日程: WorldOccasion[];
  指标: Record<string, WorldMetric>;
  /** 此刻正在酝酿/进行中/收尾的事(**永不出现 阶段 === "已结束"**); 已结束的搬去 `已结束` */
  事件: WorldEvent[];
  /** 已结束的事(墓碑): 由代码维护, AI 看不见、也不带回。注入与主 AI 完全无关, 只供面板回顾 */
  已结束: WorldEvent[];
  组织: Record<string, WorldFaction>;
  /** 上次推进的一句话小结(面板显示用) */
  小结: string;
  统计: WorldStats;
  /** 快照锚定的楼层号(-1=无快照) */
  锚点楼层: number;
  /** 已推进到哪条楼层 */
  处理到楼层: number;
  /** 清空层(来自聊天变量): 清空后只推进比它更新的楼层 */
  清空层: number;
  /** 持久读取截止；null/缺失表示未清空，不随首轮推进消费。 */
  清空截止?: number | null;
  /** 本聊天的传讯速度(v2.9.2)。来自**聊天变量**(与清空层同一处), 不在楼层快照里 ——
   *  删楼/重 roll 不会把它退回去, 清空世界也保留它(它是这个聊天的设定, 不是世界状态)。
   *  缺失 = 未选(只在选过非"未选"时才出现这个键, 旧数据形状不变)。 */
  传讯速度?: 传讯速度;
  /** 代码维护的提交修订与清空世代，模型不可修改。 */
  修订?: number;
  世代?: number;
  /** 本次已处理输入的完整身份，避免相同消息通知重复推进。 */
  处理签名?: string;
  /** 上一次注入给主 AI 的事件键(id 或标题), 只供注入挑选的粘性分用(v2.9.0)。
   *  由 update.ts 在提交快照时写入, 随楼层快照存亡; 缺失 = 没有粘性(旧快照/新开局)。
   *  它不是"哪些事还在发生"的记录, 也不进模型请求。 */
  上次注入?: string[];
  已失效暗线?: WorldSeed[];
  已过期日程?: WorldOccasion[];
  已解体组织?: WorldArchivedFaction[];
  已平息形势?: WorldArchivedTrend[];
  /** 每次维护的完整诊断；不把被额度拒绝误报为剧情了结。 */
  维护备注?: string[];
}

export const EVENT_SCALE: 事件规模[] = ['一般', '重大'];
export const EVENT_SPREAD: 事件传播[] = ['本地', '区域', '全域'];
export const EVENT_STAGE: 事件阶段[] = ['酝酿', '进行中', '收尾', '已结束'];
export const EVENT_SECRECY: 事件公开性[] = ['公开', '保密'];
export const SEED_MATURITY: 暗线成熟度[] = ['酝酿', '临近', '已发生', '已失效'];

/**
 * v2.10.0 旧取值 → 新取值(规模 / 传播 / 阶段 / 隐秘 / 成熟度 五个枚举字段)。
 *
 * 为什么要有这张表: 枚举字段读到白名单之外的值会**纠偏成兜底值**。只改白名单不迁移,
 * 旧存档里的"天下"读回来就会被悄悄改成"本地"、"大事"变"一般"、"已爆发"变"酝酿"——不报错, 也看不出来。
 * 所以凡是枚举纠偏的地方(字段表 字段值 / 世界数据 pickEnum / normalizeEvent)都先过一遍这张表。
 * 它覆盖三个入口: 旧楼层快照与归档池、模型照旧习惯输出的老词、面板手改。
 * 只按值换、不看字段: 这些旧词在五个字段里各只属于一个字段, 不会串。没出现在表里的值原样往下走(照旧纠偏)。
 */
export const 旧枚举值: Readonly<Record<string, string>> = {
  要事: '一般',
  大事: '重大',
  本埠: '本地',
  天下: '全域',
  进行: '进行中',
  尾声: '收尾',
  隐秘: '保密',
  将熟: '临近',
  已爆发: '已发生',
  已消亡: '已失效',
};

/**
 * v2.10.1 旧层名 → 新层名(快照与模型输出的顶层键)。
 * 旧快照、归档池里的旧引用、模型照旧写的老键都在读进来时搬到新名下; 新名已有值时以新名为准, 旧键丢弃。
 */
export const 旧层名: Readonly<Record<string, string>> = {
  地域: '地区',
  大势: '形势',
  伏笔: '暗线',
  节令: '日程',
  势力: '组织',
  已了结: '已结束',
  已失效伏笔: '已失效暗线',
  已过期节令: '已过期日程',
  已了结引用: '已结束引用',
  已失效伏笔引用: '已失效暗线引用',
  已过期节令引用: '已过期日程引用',
};

/** v2.10.1 条目里的旧字段名 → 新字段名(各层条目与事件共用; 势力 / 隐秘 只出现在事件上) */
export const 旧字段名: Readonly<Record<string, string>> = {
  前情: '背景',
  埋设: '线索',
  当权者: '主事方',
  对外关系: '外部关系',
  头面人物: '负责人',
  势力范围: '覆盖范围',
  势力: '组织',
  隐秘: '公开性',
};

function 搬键(对象: Record<string, unknown>, 表: Readonly<Record<string, string>>): void {
  // 按原键序**就地改名**: 旧键在它原来的位置换成新名, 不搬到末尾。
  // 用例把"地区条目"的键序也钉住了(主事方 → 外部关系 → 背景), 搬到末尾会变成 背景 → 主事方 → 外部关系。
  const 原有键 = new Set(Object.keys(对象));
  const 结果: Record<string, unknown> = {};
  for (const [键, 值] of Object.entries(对象)) {
    const 新键 = 表[键] ?? 键;
    // 新名已有值时以新名为准: 旧键丢掉(不管新旧哪个先出现)
    if (新键 !== 键 && 原有键.has(新键)) continue;
    if (新键 in 结果) continue;
    结果[新键] = 值;
  }
  for (const 键 of Object.keys(对象)) delete 对象[键];
  Object.assign(对象, 结果);
}

/** 一条档案 / 事件的旧字段名搬到新名下(浅拷贝, 不改入参) */
export function 迁移条目键<T>(条目: T): T {
  if (!条目 || typeof 条目 !== 'object' || Array.isArray(条目)) return 条目;
  const 新 = { ...(条目 as Record<string, unknown>) };
  搬键(新, 旧字段名);
  return 新 as T;
}

/**
 * 整份快照 / 模型载荷: 顶层旧层名搬到新名下, 各层条目与事件里的旧字段名也一并搬(浅拷贝, 不改入参)。
 * 只碰本表认识的键; 「世界」里的旧 大势(v1.x 的一句话总览)由各自的读取点另行处理, 这里不动。
 */
export function 迁移旧键名<T>(载荷: T): T {
  if (!载荷 || typeof 载荷 !== 'object' || Array.isArray(载荷)) return 载荷;
  const 新 = { ...(载荷 as Record<string, any>) };
  搬键(新, 旧层名);
  for (const 层 of ['地区', '形势', '组织', '指标']) {
    const 表 = 新[层];
    if (表 && typeof 表 === 'object' && !Array.isArray(表)) 新[层] = Object.fromEntries(Object.entries(表).map(([名, 条目]) => [名, 迁移条目键(条目)]));
  }
  for (const 层 of ['暗线', '日程', '事件', '已结束', '已失效暗线', '已过期日程']) {
    if (Array.isArray(新[层])) 新[层] = 新[层].map(迁移条目键);
  }
  return 新 as T;
}

/** 枚举字段的值先过一遍旧值表(去首尾空白后查); 不是旧值就原样返回(包括非字符串) */
export function 迁移枚举值<T>(值: T): T | string {
  if (typeof 值 !== 'string') return 值;
  const 去空白 = 值.trim();
  return Object.prototype.hasOwnProperty.call(旧枚举值, 去空白) ? 旧枚举值[去空白] : 值;
}
export const METRIC_TREND: 指标趋势[] = ['上升', '下降', '平稳'];
