import { z } from 'zod';

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
        /** 把世界动向写入角色卡主世界书的常驻条目(蓝灯常开), 主 AI 每回合都能读到 */
        注入世界书条目: z.boolean().default(true),
        /** @deprecated 迫近机制已废弃, 保留仅为兼容旧设置; 引擎不再使用 */
        迫近闯入: z.enum(['可以', '应当']).default('可以'),
        /** 隐秘事件注入主 AI: 默认关闭(隐秘事件只进面板供烟火推演); 开启后以"主角绝不可能知道"的标注注入 */
        注入隐秘事件: z.boolean().default(false),
        /** 节令历法层: 按世界观生成节庆/汛期/开市/检阅等周期性临近事件(默认开) */
        节令历法: z.boolean().default(true),
        /** 世界指标层: 少量慢变数值(丰歉/物价/能源/民心等, 按世界观取名), 事件推动它们、它们反过来生事件(默认开) */
        世界指标: z.boolean().default(true),
        /** 世界推进时读取世界书(与主 AI 相同的激活方式) */
        读取世界书: z.boolean().default(true),
        /** 读取世界书时是否包含全局世界书(默认只读角色卡主+附加与聊天世界书) */
        读取全局世界书: z.boolean().default(false),
        /** 读取世界书时排除的条目名(列表): 填条目名(或其关键词)即不读该条目 */
        世界书排除: z.array(z.string()).default([]),
        /** 预填充(prefill): 在最后追加一条 assistant 消息引导模型直接从 JSON 开始输出 */
        预填充: z.boolean().default(false),
        /** 破限: 开启后向世界引擎注入两段式破限(系统段缝在系统提示词末尾 + AI段伪装成模型自己说过的话), 供有内容政策拦截的接口使用 */
        破限: z.boolean().default(false),
        /** 头部填充: 开启后把"头部填充文本"(留空则用内置小说原文)作为第一条消息单独发送(与彼方同款), 无实际指令, "塞垃圾"占注意力防截断——适合 Gemini 3.7 Flash */
        头部填充: z.boolean().default(false),
        /** 头部填充的自定义文本: 留空使用内置小说原文 */
        头部填充文本: z.string().default(''),
        /** 防截断: 免责声明示例段(Reference_Example_format)缝在 system 提示词末尾 */
        防截断: z.boolean().default(false),
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

export type 事件规模 = '要事' | '大事';
export type 事件传播 = '本埠' | '区域' | '天下';
export type 事件阶段 = '酝酿' | '进行' | '尾声' | '已结束';
export type 事件隐秘 = '公开' | '隐秘';
export type 伏笔成熟度 = '酝酿' | '将熟' | '已爆发';
export type 指标趋势 = '上升' | '下降' | '平稳';

/** 一条事件演变记录: 每次实质推进追加一条(脚本端累积, 最新在后) */
export interface EventEvolution {
  /** 该次推进后的世界时间 */
  时间: string;
  /** 这一次推进发生了什么(一句话) */
  变化: string;
}

/** 一条世界事件(纪事条目)。事件是世界自身的公共层动态, 与主角无关 */
export interface WorldEvent {
  /** 事件唯一标识(脚本签发, AI 只需原样带回): 标题可能被 AI 改动, 对账先按 id 再按标题兜底, 靠 id 保住演变与前情 */
  id: string;
  标题: string;
  描述: string;
  地点: string;
  时间: string;
  规模: 事件规模;
  传播: 事件传播;
  渠道: string;
  势力: string;
  阶段: 事件阶段;
  /** 这件事是否各方秘而不宣: 隐秘=暗中行动, 不走公共渠道, 默认不注入主 AI */
  隐秘: 事件隐秘;
  /** 代表人物: 该事件中站在台前的 1~2 个具体人物(头衔+名字, 如"首席信息官·林素问"), 纯公共身份, 不写私人动态 */
  代表人物: string;
  /** 前情: 这件事的来龙去脉总结(含起因), AI 滚动维护——每次推进把本次变化折进上一次前情 */
  前情: string;
  /** 演变流水(脚本端累积, 最新在后): 面板的精确轨迹, AI 整体替换事件清单也吞不掉 */
  演变: EventEvolution[];
}

/** 一个势力的当前盘算(有自主目标、持续行动、能影响事件走向的集体) */
export interface WorldFaction {
  目标: string;
  动向: string;
  /** 前情: 该势力的来龙去脉滚动总结(怎么起家/为何有此目标), AI 每轮把新变化折进旧前情带回 */
  前情: string;
  /** 势力范围: 地盘与影响的复合描述——传统势力写地盘("北境三城"), 影响力型势力写主导的行业/阶层/渠道("好莱坞六大制片厂主导"), 兼有则都写 */
  势力范围: string;
  /** 对外关系: 与其他势力的当前关系(如"与X商团盟约渐固; 与Y帮派摩擦升级"), 逐条一句话 */
  对外关系: string;
  /** 头面人物: 它的首领/掌门/代言人(头衔+名字, 如"家主·林远山"), 主 AI 写戏时知道谁出面; 慢变字段 */
  头面人物: string;
}

/** 地域: 城市/地区/星区/国度等常驻实体, 事件的地理来源 */
export interface WorldRegion {
  /** 概况: 地理、物产、风貌(慢变) */
  概况: string;
  /** 局势: 当前局势与民生(可每轮推进) */
  局势: string;
  /** 当权者: 治理者或主导势力 */
  当权者: string;
  /** 对外关系: 与周边地域/势力的关系 */
  对外关系: string;
  /** 前情: 演变因果(怎么走到今天), 不复述概况 */
  前情: string;
}

/** 大势: 世界层面正在流动的大趋势(战云/商路/教派/新政/灾荒), 会自己推进并催生事件 */
export interface WorldTrend {
  /** 概况: 这股大势是什么 */
  概况: string;
  /** 进展: 当前推进到哪一步 */
  进展: string;
  /** 走向: 可能导向什么 */
  走向: string;
  /** 前情: 演变因果(怎么走到今天), 不复述概况 */
  前情: string;
}

/** 伏笔: 埋下的长期线头, 跨回合成熟后爆发为事件 */
export interface WorldSeed {
  标题: string;
  /** 埋设: 埋下的前提/线头 */
  埋设: string;
  /** 指向: 成熟时可能导向什么 */
  指向: string;
  成熟度: 伏笔成熟度;
  /** 前情: 演变因果(怎么走到今天), 不复述概况 */
  前情: string;
}

/** 节令: 按世界观生成的周期性或临近的公共事件节点(节庆/汛期/开市/检阅/换届) */
export interface WorldOccasion {
  名称: string;
  /** 周期: 每年/每季/每月/一次性 等 */
  周期: string;
  /** 时间: 下次发生时间(与"世界.时间"同格式) */
  时间: string;
  /** 概况: 这是什么 */
  概况: string;
}

/** 世界指标: 少量慢变数值, 事件推动它们、它们反过来生事件 */
export interface WorldMetric {
  /** 值: 数值或档位(按世界观) */
  值: string;
  趋势: 指标趋势;
  说明: string;
}

export interface WorldInfo {
  时间: string;
  氛围: string;
  /** 总览: 一两句世界总体走向(原「大势」, 与结构化「大势」层区分) */
  总览: string;
}

export interface WorldStats {
  推进次数: number;
  最后推进: number;
}

/** 世界状态本体(整体写入楼层快照, 随楼层存亡) */
export interface WorldData {
  版本: number;
  世界: WorldInfo;
  地域: Record<string, WorldRegion>;
  大势: Record<string, WorldTrend>;
  伏笔: WorldSeed[];
  节令: WorldOccasion[];
  指标: Record<string, WorldMetric>;
  事件: WorldEvent[];
  势力: Record<string, WorldFaction>;
  /** 上次推进的一句话小结(面板显示用) */
  小结: string;
  统计: WorldStats;
  /** 快照锚定的楼层号(-1=无快照) */
  锚点楼层: number;
  /** 已推进到哪条楼层 */
  处理到楼层: number;
  /** 清空层(来自聊天变量): 清空后只推进比它更新的楼层 */
  清空层: number;
}

export const EVENT_SCALE: 事件规模[] = ['要事', '大事'];
export const EVENT_SPREAD: 事件传播[] = ['本埠', '区域', '天下'];
export const EVENT_STAGE: 事件阶段[] = ['酝酿', '进行', '尾声', '已结束'];
export const EVENT_SECRECY: 事件隐秘[] = ['公开', '隐秘'];
export const SEED_MATURITY: 伏笔成熟度[] = ['酝酿', '将熟', '已爆发'];
export const METRIC_TREND: 指标趋势[] = ['上升', '下降', '平稳'];
