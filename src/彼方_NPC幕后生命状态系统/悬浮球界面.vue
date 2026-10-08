<template>
  <div ref="rootEl" class="bf-root" :data-theme="theme">
    <!-- 悬浮球 (可拖动): 关闭时填满 40px 圆形 iframe, 打开时 iframe 全屏、球按锚点定位 -->
    <div
      class="bf-orb"
      :class="{ dragging: isDragging }"
      :style="panelOpen ? { left: anchorX - CLOSED_SIZE / 2 + 'px', top: anchorY - CLOSED_SIZE / 2 + 'px' } : { left: '0px', top: '0px' }"
      :title="panelOpen ? '收起彼方' : '打开彼方'"
      @pointerdown="onOrbPointerDown"
      @click="onOrbClick"
    >
      <svg class="bf-orb-icon" viewBox="0 0 48 48" fill="none" aria-hidden="true">
        <defs>
          <linearGradient id="bf-orb-star-grad" x1="10" y1="8" x2="38" y2="40" gradientUnits="userSpaceOnUse">
            <stop offset="0" stop-color="var(--bf-accent-text)" />
            <stop offset="1" stop-color="var(--bf-accent-strong)" />
          </linearGradient>
        </defs>
        <path
          d="M24 7 C25.6 17.2 30.8 22.4 41 24 C30.8 25.6 25.6 30.8 24 41 C22.4 30.8 17.2 25.6 7 24 C17.2 22.4 22.4 17.2 24 7 Z"
          stroke="url(#bf-orb-star-grad)"
          stroke-width="1.7"
          stroke-linejoin="round"
        />
      </svg>
      <svg class="bf-orb-comp" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="M8 2.5 C8.9 7 9 7.1 13.5 8 C9 8.9 8.9 9 8 13.5 C7.1 9 7 8.9 2.5 8 C7 7.1 7.1 7 8 2.5 Z"
          stroke="currentColor"
          stroke-width="1.2"
          stroke-linejoin="round"
        />
      </svg>
      <span v-if="updatingActive" class="bf-orb-spinner"></span>
    </div>

    <!-- 居中弹窗面板 -->
    <Transition name="bf-fade">
      <div v-if="panelOpen" class="bf-backdrop" @click="closePanel"></div>
    </Transition>

    <Transition name="bf-pop">
      <div v-if="panelOpen" class="bf-panel" @click.stop>
        <!-- Header -->
        <header class="bf-header">
          <div class="bf-brand">
            <div class="bf-logo">
              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <defs>
                  <linearGradient id="bf-logo-star-grad" x1="5" y1="4" x2="19" y2="20" gradientUnits="userSpaceOnUse">
                    <stop offset="0" stop-color="#fdf6e7" />
                    <stop offset="1" stop-color="var(--bf-accent)" />
                  </linearGradient>
                </defs>
                <path
                  d="M12 3.5 C13.1 8.6 15.4 10.9 20.5 12 C15.4 13.1 13.1 15.4 12 20.5 C10.9 15.4 8.6 13.1 3.5 12 C8.6 10.9 10.9 8.6 12 3.5 Z"
                  stroke="url(#bf-logo-star-grad)"
                  stroke-width="1.5"
                  stroke-linejoin="round"
                />
              </svg>
            </div>
            <div class="bf-brand-text">
              <div class="bf-title">
                彼方
                <span class="bf-title-en">Elsewhere</span>
              </div>
              <div class="bf-subtitle">NPC 幕后生命状态系统</div>
            </div>
          </div>

          <!-- 顶部导航栏 -->
          <nav class="bf-navbar">
            <button
              v-for="item in tabs"
              :key="item.key"
              class="bf-nav"
              :class="{ active: tab === item.key }"
              @click="tab = item.key"
            >
              <component :is="item.icon" class="bf-nav-icon" :size="16" :weight="tab === item.key ? 'fill' : 'regular'" />
              <span class="bf-nav-label">{{ item.label }}</span>
            </button>
          </nav>

          <div class="bf-header-right">
            <div class="bf-ready" :class="{ ok: ready }" :title="statusTitle">
              <span class="bf-dot"></span>
              {{ ready ? '已就绪' : '未配置' }}
            </div>
            <div class="bf-clock">{{ nowText }}</div>
            <button class="bf-btn bf-btn-sm bf-btn-primary" :disabled="updating" @click="manualUpdate">
              <span v-if="updating" class="bf-spinner"></span>
              <PhArrowsClockwise v-else :size="14" weight="bold" />
              <span>{{ updating ? '更新中…' : '更新' }}</span>
            </button>
            <button
              class="bf-icon-btn bf-theme-btn"
              :title="theme === 'light' ? '切换到深色模式' : '切换到白天模式'"
              @click="toggleTheme"
            >
              <PhSun v-if="theme === 'light'" :size="17" weight="duotone" />
              <PhMoon v-else :size="17" weight="duotone" />
            </button>
            <button class="bf-icon-btn" title="收起" @click="closePanel"><PhX :size="16" weight="bold" /></button>
          </div>
        </header>

        <!-- 主内容 -->
        <div class="bf-body">
          <main class="bf-main">
            <Transition name="bf-pagefade" mode="out-in">
              <!-- 仪表盘 -->
              <div v-if="tab === 'dashboard'" key="dashboard" class="bf-page">
                <div class="bf-page-title"><PhGauge :size="18" weight="duotone" /> 仪表盘</div>

                <div class="bf-dash-layout">
                  <!-- 左栏：追踪 NPC 生活网格 -->
                  <div class="bf-dash-main">
                    <div class="bf-panel-card">
                      <div class="bf-panel-card-title">
                        <PhUsers :size="14" weight="duotone" /> 追踪的 NPC
                        <span class="bf-panel-card-count">{{ npcList.length }}</span>
                      </div>
                      <div class="bf-row">
                        <input v-model="newNpcName" class="bf-input" placeholder="输入NPC名字后回车或点添加" @keyup.enter="openAddDialog" />
                        <button class="bf-btn" @click="openAddDialog"><PhUserPlus :size="15" weight="bold" />添加</button>
                      </div>
                      <div v-if="npcList.length === 0" class="bf-empty">
                        <div class="bf-empty-text">还没有追踪任何 NPC</div>
                        <div class="bf-empty-hint">{{ autoTrackEnabled ? '添加名字，或留空让 AI 自动识别重要NPC后点「手动更新」' : '「正文新角色自动建档」已关闭，新角色不会自动加入，需在此手动添加名字' }}</div>
                      </div>
                      <div v-else class="bf-dash-npcs">
                        <div v-for="name in npcList" :key="name" class="bf-dash-npc" @click="openNpc(name)">
                          <span class="bf-avatar">{{ name.trim().slice(0, 1) || '?' }}</span>
                          <div class="bf-dash-npc-main">
                            <div class="bf-dash-npc-name">{{ name }}</div>
                            <div class="bf-dash-npc-loc">{{ data.NPC?.[name]?.['位置'] || '未知位置' }}</div>
                          </div>
                          <button class="bf-icon-btn bf-npc-del" title="从追踪名单删除" @click.stop="removeNpc(name)"><PhX :size="13" weight="bold" /></button>
                        </div>
                      </div>
                    </div>

                    <div class="bf-dash-actions">
                      <button class="bf-btn bf-btn-primary" :disabled="updating" @click="manualUpdate">
                        <span v-if="updating" class="bf-spinner"></span>
                        <PhArrowsClockwise v-else :size="15" weight="bold" />{{ updating ? '更新中…' : '手动更新' }}
                      </button>
                      <button class="bf-btn" :disabled="updating" @click="reload"><PhArrowsClockwise :size="15" weight="bold" />刷新</button>
                      <button class="bf-btn bf-btn-danger" :disabled="updating" @click="clearAll">
                        <PhTrash :size="15" weight="bold" />{{ clearing ? '再点一次确认清空' : '清空' }}
                      </button>
                    </div>
                  </div>

                  <!-- 右栏：生活统计概览 -->
                  <div class="bf-dash-side">
                    <div class="bf-side-card">
                      <div class="bf-side-num">{{ stats.更新次数 }}</div>
                      <div class="bf-side-label"><PhArrowsClockwise :size="13" weight="duotone" /> 更新次数</div>
                    </div>
                    <div class="bf-side-card">
                      <div class="bf-side-num">{{ npcEntries.length }}</div>
                      <div class="bf-side-label"><PhUsersThree :size="13" weight="duotone" /> 追踪 NPC</div>
                    </div>
                    <div class="bf-side-card">
                      <div class="bf-side-num bf-side-clock">{{ nowClock }}</div>
                      <div class="bf-side-label"><PhClock :size="13" weight="duotone" /> 当前时间</div>
                    </div>
                  </div>
                </div>
              </div>

              <!-- NPC Master-Detail -->
              <div v-else-if="tab === 'npc'" key="npc" class="bf-page bf-npc-layout">
                <div class="bf-npc-list">
                  <div v-if="npcEntries.length === 0" class="bf-empty">
                    <div class="bf-empty-text">还没有 NPC</div>
                    <div class="bf-empty-hint">{{ autoTrackEnabled ? '在仪表盘「追踪 NPC 管理」添加，或留空让 AI 自动识别后点「手动更新」' : '「正文新角色自动建档」已关闭，在仪表盘手动添加名字后更新即可建档' }}</div>
                  </div>
                  <div
                    v-for="[name, card] in npcEntries"
                    :key="name"
                    class="bf-npc-item"
                    :class="{ active: selectedNpc === name }"
                    @click="selectedNpc = name"
                  >
                    <span class="bf-avatar">{{ name.trim().slice(0, 1) || '?' }}</span>
                    <div class="bf-npc-item-main">
                      <div class="bf-npc-item-top">
                        <span class="bf-npc-name">{{ name }}</span>
                        <span class="bf-online-dot" title="追踪中"></span>
                      </div>
                      <div class="bf-npc-sub">
                        <span class="bf-npc-loc"><PhMapPin :size="11" weight="duotone" /><span class="bf-npc-loc-text">{{ card['位置'] || '未知位置' }}</span></span>
                        <span class="bf-npc-sep">·</span>
                        <span class="bf-npc-status">{{ npcStatusText(card) }}</span>
                      </div>
                      <div class="bf-npc-tags">
                        <span v-for="t in npcTags(card)" :key="t.label" class="bf-tag" :class="'bf-tag-' + t.color">{{ t.label }}</span>
                      </div>
                    </div>
                  </div>
                </div>

                <div class="bf-npc-detail">
                  <template v-if="selectedNpcCard">
                    <div class="bf-detail-head">
                      <span class="bf-avatar bf-avatar-lg">{{ selectedNpc!.trim().slice(0, 1) || '?' }}</span>
                      <div class="bf-detail-head-text">
                        <div class="bf-detail-name">{{ selectedNpc }}</div>
                        <div class="bf-npc-tags">
                          <span v-for="t in npcTags(selectedNpcCard)" :key="t.label" class="bf-tag" :class="'bf-tag-' + t.color">{{ t.label }}</span>
                        </div>
                      </div>
                      <div v-if="data.剧情时间 || selectedNpcCard['最后更新']" class="bf-detail-updated">
                        <template v-if="data.剧情时间">剧情时间: {{ data.剧情时间 }}</template>
                        <template v-else>更新于 {{ fmtTime(selectedNpcCard['最后更新']) }}</template>
                      </div>
                      <div class="bf-detail-actions">
                        <button v-if="!editingNpc" class="bf-btn bf-btn-mini" @click="startEditNpc"><PhPencilSimple :size="13" weight="bold" />编辑</button>
                        <template v-else>
                          <button class="bf-btn bf-btn-mini bf-btn-primary" @click="saveEditNpc"><PhCheck :size="13" weight="bold" />保存</button>
                          <button class="bf-btn bf-btn-mini" @click="cancelEditNpc"><PhX :size="13" weight="bold" />取消</button>
                        </template>
                      </div>
                    </div>

                    <!-- 核心状态区：当前在做 / 当前状态 / 位置 -->
                    <div class="bf-detail-spotlight">
                      <div v-if="selectedNpcCard['当前在做'] || editingNpc" class="bf-spot">
                        <div class="bf-spot-icon"><PhFootprints :size="15" weight="duotone" /></div>
                        <div class="bf-spot-main">
                          <span class="bf-spot-label">当前在做</span>
                          <textarea
                            v-if="editingNpc"
                            v-model="editDraft['当前在做']"
                            class="bf-textarea bf-textarea-short"
                            rows="2"
                          ></textarea>
                          <div v-else class="bf-spot-value">{{ cleanText(selectedNpcCard['当前在做']) }}</div>
                        </div>
                      </div>
                      <div v-if="selectedNpcCard['当前状态'] || editingNpc" class="bf-spot">
                        <div class="bf-spot-icon"><PhPulse :size="15" weight="duotone" /></div>
                        <div class="bf-spot-main">
                          <span class="bf-spot-label">当前状态</span>
                          <textarea
                            v-if="editingNpc"
                            v-model="editDraft['当前状态']"
                            class="bf-textarea bf-textarea-short"
                            rows="2"
                          ></textarea>
                          <div v-else class="bf-spot-value">{{ cleanText(selectedNpcCard['当前状态']) }}</div>
                        </div>
                      </div>
                      <div v-if="selectedNpcCard['位置'] || editingNpc" class="bf-spot bf-spot-loc">
                        <div class="bf-spot-icon"><PhMapPin :size="15" weight="duotone" /></div>
                        <div class="bf-spot-main">
                          <span class="bf-spot-label">位置</span>
                          <textarea
                            v-if="editingNpc"
                            v-model="editDraft['位置']"
                            class="bf-textarea bf-textarea-short"
                            rows="1"
                          ></textarea>
                          <div v-else class="bf-spot-value bf-spot-value-loc">{{ cleanText(selectedNpcCard['位置']) }}</div>
                        </div>
                      </div>
                    </div>

                    <!-- 事务台账: 「未完成事项」是数组(见 事务台账.ts), 不是字符串——单独成区块按台账渲染,
                         不能塞进下面的通用字段网格(那会把数组插值成一串 JSON)。一条一行: 编号/时间/内容/状态/结果,
                         进行中在前且醒目、已完成/已作废压暗; 改状态与结果立刻走 数据变更.ts 的 改事务状态 落进快照 -->
                    <div v-if="台账条目.length > 0 || editingNpc" class="bf-ledger">
                      <div class="bf-ledger-head">
                        <span class="bf-ledger-title"><PhHandshake :size="13" weight="duotone" /> 未完成事项 · 事务台账</span>
                        <span class="bf-ledger-hint">内容写下即冻结; 改状态/结果即时生效(不必点「编辑」)</span>
                      </div>
                      <div v-if="台账条目.length === 0" class="bf-ledger-blank">暂无</div>
                      <div v-else class="bf-ledger-list">
                        <div
                          v-for="事务 in 台账条目"
                          :key="事务.编号"
                          class="bf-ledger-item"
                          :class="'is-' + 状态类(事务.状态)"
                        >
                          <div class="bf-ledger-row">
                            <span class="bf-ledger-no">{{ 事务.编号 }}</span>
                            <span v-if="事务.时间" class="bf-ledger-time">{{ 事务.时间 }}</span>
                            <span class="bf-ledger-state" :class="'is-' + 状态类(事务.状态)">{{ 事务.状态 }}</span>
                            <span class="bf-ledger-content">{{ 事务.内容 }}</span>
                          </div>
                          <div v-if="事务.结果" class="bf-ledger-resulttext">结果: {{ 事务.结果 }}</div>
                          <div class="bf-ledger-actions">
                            <input
                              v-model="结果草稿[事务.编号]"
                              class="bf-input bf-ledger-result"
                              :placeholder="事务.结果 ? '改写结果(提交即覆盖)' : '结果(可选)'"
                              :disabled="updating"
                            />
                            <div class="bf-seg bf-ledger-seg">
                              <button
                                v-for="状态 in 台账状态表"
                                :key="状态"
                                class="bf-btn bf-btn-mini"
                                :class="{ active: 事务.状态 === 状态 }"
                                :disabled="updating"
                                :title="`把 ${事务.编号} 标记为${状态}`"
                                @click="改事务(事务, 状态)"
                              >
                                {{ 状态 }}
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>

                    <!-- 分组字段 -->
                    <div class="bf-detail-groups">
                      <div v-for="组 in detailFields" :key="组.key" class="bf-field-group">
                        <div class="bf-field-group-title"><component :is="组.图标" :size="13" weight="duotone" /> {{ 组.标题 }}</div>
                        <div class="bf-field-grid">
                          <div v-for="field in 组.字段" :key="field" v-show="selectedNpcCard[field] || editingNpc" class="bf-field">
                            <span class="bf-field-label" :title="字段说明表[field] || field">{{ field }}</span>
                            <textarea
                              v-if="editingNpc"
                              v-model="editDraft[field]"
                              class="bf-textarea bf-textarea-short"
                              rows="2"
                            ></textarea>
                            <span v-else class="bf-field-value">{{ cleanText(selectedNpcCard[field]) }}</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  </template>
                  <div v-else class="bf-empty">
                    <div class="bf-empty-text">从左侧选择一个 NPC 查看详情</div>
                  </div>
                </div>
              </div>

              <!-- 一致性检查 -->
              <div v-else-if="tab === 'consistency'" key="consistency" class="bf-page">
                <div class="bf-page-title"><PhShieldCheck :size="18" weight="duotone" /> 事实档案</div>
                <div class="bf-page-hint">
                  每个 NPC 当下"记得"什么——承诺/近期关键事件/身份锚点。这些跨楼层事实档案会发送给彼方更新 AI,
                  并在开启注入后提供给主 AI; 代码会自动追加/去重/保留最近三条, 看到明显错误时可在 NPC 详情手动修正。
                </div>
                <div v-if="consistencyList.length === 0" class="bf-empty">
                  <div class="bf-empty-text">还没有 NPC 状态卡</div>
                  <div class="bf-empty-hint">更新一次后这里会显示每个 NPC 的一致性档案</div>
                </div>
                <div v-else class="bf-consistency-list">
                  <div v-for="item in consistencyList" :key="item.name" class="bf-panel-card bf-consistency-card">
                    <div class="bf-consistency-head">
                      <span class="bf-consistency-name">{{ item.name }}</span>
                      <span v-if="item.锚点" class="bf-consistency-anchor">{{ item.锚点 }}</span>
                    </div>
                    <div class="bf-consistency-grid">
                      <div v-if="item.未完成事项.length > 0" class="bf-consistency-row">
                        <span class="bf-consistency-label"><PhHandshake :size="12" weight="duotone" /> 未完成承诺</span>
                        <!-- 「未完成事项」是事务台账数组, 不能直接插值(会渲染成一串 JSON); 一条一行, 已办弱化 -->
                        <div class="bf-consistency-value bf-consistency-ledger">
                          <div
                            v-for="事务 in item.未完成事项"
                            :key="事务.编号"
                            class="bf-ledger-line"
                            :class="'is-' + 状态类(事务.状态)"
                          >
                            <span class="bf-ledger-no">{{ 事务.编号 }}</span>
                            <span class="bf-ledger-state" :class="'is-' + 状态类(事务.状态)">{{ 事务.状态 }}</span>
                            <span class="bf-ledger-line-text">{{ 事务.内容 }}<template v-if="事务.结果"> → {{ 事务.结果 }}</template></span>
                          </div>
                        </div>
                      </div>
                      <div v-if="item.近期关键事件" class="bf-consistency-row">
                        <span class="bf-consistency-label"><PhBookmarkSimple :size="12" weight="duotone" /> 近期关键事件</span>
                        <span class="bf-consistency-value">{{ item.近期关键事件 }}</span>
                      </div>
                      <div v-if="item.未完成事项.length === 0 && !item.近期关键事件" class="bf-consistency-row bf-consistency-empty">
                        <span class="bf-consistency-value">该 NPC 暂无事实档案(可在 NPC 详情页手动添加)</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <!-- 日志 -->
              <div v-else-if="tab === 'logs'" key="logs" class="bf-page">
                <div class="bf-page-title"><PhScroll :size="18" weight="duotone" /> 日志</div>

                <div class="bf-logs-layout">
                  <!-- 左栏：本轮更新记录 -->
                  <div class="bf-logs-main">
                    <template v-if="debugLog">
                      <div class="bf-panel-card">
                        <div class="bf-debug-head bf-debug-head-section">
                          <span class="bf-debug-head-label"><PhClipboardText :size="15" weight="duotone" /> 彼方更新记录</span>
                        </div>
                        <div class="bf-debug-meta">
                          <div class="bf-debug-meta-row">
                            <span class="bf-debug-meta-label">更新楼层</span>
                            <span>#{{ debugLog.replyIds.length > 0 ? debugLog.replyIds.join('、#') : '—' }}</span>
                          </div>
                          <div class="bf-debug-meta-row">
                            <span class="bf-debug-meta-label">模型</span>
                            <span>{{ debugLog.model || '—' }}</span>
                          </div>
                          <div class="bf-debug-meta-row">
                            <span class="bf-debug-meta-label">更新时间</span>
                            <span>{{ fmtTime(debugLog.time) }}</span>
                          </div>
                          <div class="bf-debug-meta-row">
                            <span class="bf-debug-meta-label">更新NPC</span>
                            <span>{{ debugLog.updatedNpcs.join('、') || '—' }}</span>
                          </div>
                          <div v-if="debugLog.removedNpcs.length > 0" class="bf-debug-meta-row">
                            <span class="bf-debug-meta-label">移除NPC</span>
                            <span>{{ debugLog.removedNpcs.join('、') }}</span>
                          </div>
                          <div v-if="debugLog.replyPreview" class="bf-debug-meta-row">
                            <span class="bf-debug-meta-label">回复开头</span>
                            <span class="bf-debug-preview">{{ debugLog.replyPreview }}</span>
                          </div>
                        </div>
                      </div>

                      <div class="bf-panel-card">
                        <div class="bf-debug-head">
                          <span class="bf-debug-head-label"><PhPaperPlaneRight :size="14" weight="duotone" /> 发送给 AI 的内容</span>
                          <button class="bf-btn bf-btn-mini" @click="copyText(debugLog.request)"><PhCopy :size="12" weight="bold" />复制</button>
                        </div>
                        <details>
                          <summary class="bf-debug-summary">展开查看（{{ debugLog.request.length }} 字）</summary>
                          <pre class="bf-debug-pre">{{ debugLog.request }}</pre>
                        </details>
                      </div>

                      <div class="bf-panel-card">
                        <div class="bf-debug-head">
                          <span class="bf-debug-head-label"><PhChatText :size="14" weight="duotone" /> AI 输出内容</span>
                          <button class="bf-btn bf-btn-mini" @click="copyText(debugLog.response)"><PhCopy :size="12" weight="bold" />复制</button>
                        </div>
                        <details>
                          <summary class="bf-debug-summary">展开查看（{{ debugLog.response.length }} 字）</summary>
                          <pre class="bf-debug-pre">{{ debugLog.response }}</pre>
                        </details>
                      </div>

                      <div v-if="debugLog.error" class="bf-panel-card bf-debug-error">
                        <div class="bf-debug-head">
                          <span class="bf-debug-head-label"><PhWarning :size="14" weight="duotone" /> 报错内容</span>
                          <button class="bf-btn bf-btn-mini" @click="copyText(debugLog.error)"><PhCopy :size="12" weight="bold" />复制</button>
                        </div>
                        <pre class="bf-debug-pre">{{ debugLog.error }}</pre>
                      </div>

                      <div class="bf-dash-actions">
                        <button class="bf-btn bf-btn-primary" @click="copyErrorReport"><PhClipboardText :size="14" weight="bold" />复制报错内容发给助手</button>
                        <button class="bf-btn" @click="debugStore.clear()">清空更新记录</button>
                      </div>
                    </template>
                    <div v-else class="bf-panel-card">
                      <div class="bf-empty">
                        <div class="bf-empty-text">还没有更新日志</div>
                        <div class="bf-empty-hint">手动更新或自动更新后会记录本轮发送与输出内容</div>
                      </div>
                    </div>
                  </div>

                  <!-- 右栏：注入内容 + 控制台 -->
                  <div class="bf-logs-side">
                    <div class="bf-panel-card">
                      <div class="bf-debug-head">
                        <span class="bf-debug-head-label"><PhBrain :size="14" weight="duotone" /> 彼方写入世界书的内容</span>
                        <template v-if="mainPrompt">
                          <button class="bf-btn bf-btn-mini" @click="copyText(mainPrompt)"><PhCopy :size="12" weight="bold" />复制</button>
                        </template>
                      </div>
                      <div v-if="mainPrompt" class="bf-hint">记录时间: {{ fmtTime(mainPromptTime) }} · 已记录 {{ mainPromptCount }} 次（写入角色卡主世界书常驻条目的幕后状态；主AI 与任何读取该世界书的环节读到的就是这一段）</div>
                      <template v-if="mainPrompt">
                        <details>
                          <summary class="bf-debug-summary">展开查看（{{ mainPrompt.length }} 字）</summary>
                          <pre class="bf-debug-pre">{{ mainPrompt }}</pre>
                        </details>
                      </template>
                      <div v-else class="bf-empty">
                        <div class="bf-empty-text">还没有写入世界书的内容</div>
                        <div class="bf-empty-hint">开启「写入世界书条目」并在更新后，这里显示彼方写入的幕后状态内容</div>
                      </div>
                    </div>

                    <div class="bf-panel-card">
                      <div class="bf-debug-head">
                        <span class="bf-debug-head-label"><PhTerminalWindow :size="14" weight="duotone" /> 控制台输出（彼方脚本自身）</span>
                        <button class="bf-btn bf-btn-mini" @click="consoleStore.clear()">清空控制台</button>
                      </div>
                      <div v-if="consoleLines.length === 0" class="bf-empty">
                        <div class="bf-empty-text">暂无控制台输出</div>
                      </div>
                      <div v-else class="bf-console">
                        <div v-for="(line, index) in consoleLinesReversed" :key="index" class="bf-console-line" :class="'bf-console-' + line.type">
                          <span class="bf-console-time">{{ fmtTime(line.time) }}</span>
                          <span class="bf-console-text">{{ line.text }}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <!-- 设置 -->
              <div v-else key="settings" class="bf-page">
                <div class="bf-page-title"><PhGearSix :size="18" weight="duotone" /> 设置</div>

                <div class="bf-settings-layout">
                  <!-- 左栏：接口配置 -->
                  <div class="bf-settings-main">
                    <div class="bf-group">
                      <div class="bf-group-title"><PhPlug :size="14" weight="duotone" /> 接口配置（OpenAI 兼容）</div>
                      <label class="bf-row">
                        <span class="bf-label">接口地址</span>
                        <input v-model="settings.接口.地址" class="bf-input" placeholder="https://api.example.com/v1" />
                      </label>
                      <div class="bf-row">
                        <span class="bf-label">API密钥</span>
                        <input
                          v-model="settings.接口.密钥"
                          class="bf-input"
                          :type="showKey ? 'text' : 'password'"
                          placeholder="sk-..."
                        />
                        <button class="bf-btn bf-btn-mini" @click="showKey = !showKey">{{ showKey ? '隐藏' : '显示' }}</button>
                      </div>
                      <div class="bf-row">
                        <span class="bf-label">模型</span>
                        <select v-model="settings.接口.模型" class="bf-input">
                          <option v-if="!modelList.includes(settings.接口.模型)" value="">（请选择模型）</option>
                          <option v-for="model in modelList" :key="model" :value="model">{{ model }}</option>
                        </select>
                      </div>
                      <div class="bf-row bf-actions">
                        <button class="bf-btn" :disabled="fetchingModels" @click="loadModels">
                          {{ fetchingModels ? '获取中…' : '获取模型列表' }}
                        </button>
                        <button class="bf-btn" :disabled="testing" @click="testConnection">
                          {{ testing ? '测试中…' : '测试连接' }}
                        </button>
                      </div>
                      <div class="bf-row-pair">
                        <div class="bf-pair">
                          <span class="bf-label">温度</span>
                          <input v-model.number="settings.接口.温度" class="bf-input bf-input-num" type="number" min="0" max="2" step="0.1" />
                        </div>
                        <div class="bf-pair">
                          <span class="bf-label">最大输出Token</span>
                          <input v-model.number="settings.接口.最大token" class="bf-input bf-input-num" type="number" min="1" max="131072" />
                        </div>
                      </div>
                      <label class="bf-toggle">
                        <input v-model="settings.接口.流式" type="checkbox" />
                        <span class="bf-toggle-track"><span class="bf-toggle-thumb"></span></span>
                        <span class="bf-toggle-text">流式输出</span>
                      </label>
                      <div class="bf-hint">请求走酒馆服务器转发，不会遇到跨域(CORS)问题；关闭流式则等整段返回</div>
                      <div class="bf-row">
                        <span class="bf-label">配置预设</span>
                        <input v-model="presetName" class="bf-input" placeholder="预设名，如 DeepSeek" @keyup.enter="saveApiPreset" />
                        <button class="bf-btn bf-btn-mini" @click="saveApiPreset">保存当前</button>
                      </div>
                      <div v-if="presetNames.length > 0" class="bf-row">
                        <select v-model="selectedPreset" class="bf-input">
                          <option value="">（选择预设加载）</option>
                          <option v-for="name in presetNames" :key="name" :value="name">{{ name }}</option>
                        </select>
                        <button class="bf-btn bf-btn-mini" @click="loadApiPreset">加载</button>
                        <button class="bf-btn bf-btn-mini" @click="deleteApiPreset">删除</button>
                      </div>
                      <div class="bf-hint">保存当前接口配置为预设，可一键切换</div>
                    </div>

                    <div class="bf-group">
                      <div class="bf-group-title"><PhStarFour :size="14" weight="duotone" /> 提示词强化</div>
                      <div class="bf-hint">改变发给彼方接口的提示词结构，用于对位特定预设/绕过限制；无需改动时保持默认</div>
                      <label class="bf-toggle">
                        <input v-model="settings.更新.提示词头部填充" type="checkbox" />
                        <span class="bf-toggle-track"><span class="bf-toggle-thumb"></span></span>
                        <span class="bf-toggle-text">提示词头部填充</span>
                      </label>
                      <div class="bf-hint">在消息最前插入文本作为第一条消息</div>
                      <textarea v-model="settings.更新.头部填充文本" class="bf-textarea bf-textarea-short" placeholder="留空使用内置「陨落的天才」(斗破苍穹)文本"></textarea>
                      <div class="bf-hint">自定义头部填充文本：想换小说直接粘贴到这里，清空则恢复内置文本；支持酒馆宏替换</div>
                      <label class="bf-toggle">
                        <input v-model="settings.更新.防截断" type="checkbox" />
                        <span class="bf-toggle-track"><span class="bf-toggle-thumb"></span></span>
                        <span class="bf-toggle-text">防截断</span>
                      </label>
                      <div class="bf-hint">gemini3.7f 对位预设[27]: 在 system 末尾缝入「牢大」免责声明段；3.6F 起不支持预填充，可关「预填充」配合</div>
                      <label class="bf-toggle">
                        <input v-model="settings.更新.破限" type="checkbox" />
                        <span class="bf-toggle-track"><span class="bf-toggle-thumb"></span></span>
                        <span class="bf-toggle-text">破限</span>
                      </label>
                      <div class="bf-hint">任务后注入 SPECIAL NOTE 身份强化(防注入/思考语气/无安全限制)并预置 AI 承诺(看过任务后的应答)；关闭后只发送任务本身</div>
                      <label class="bf-toggle">
                        <input v-model="settings.更新.预填充" type="checkbox" />
                        <span class="bf-toggle-track"><span class="bf-toggle-thumb"></span></span>
                        <span class="bf-toggle-text">预填充(prefill)</span>
                      </label>
                      <div class="bf-hint">追加 assistant 消息引导直接从 JSON 输出，减少格式失败；DeepSeek/GLM/Qwen/Claude 大多支持，报错就关</div>
                    </div>
                  </div>

                  <!-- 右栏：更新设置 + 标签过滤 -->
                  <div class="bf-settings-side">
                    <div class="bf-group">
                      <div class="bf-group-title"><PhGearSix :size="14" weight="duotone" /> 更新设置</div>
                      <label class="bf-toggle">
                        <input v-model="settings.启用幕后" type="checkbox" />
                        <span class="bf-toggle-track"><span class="bf-toggle-thumb"></span></span>
                        <span class="bf-toggle-text">启用幕后系统</span>
                      </label>
                      <div class="bf-hint">关闭后不再调用 AI 更新 NPC 状态/注入(已有状态数据保留, 重开恢复)</div>
                      <label class="bf-toggle">
                        <input v-model="settings.更新.自动更新" type="checkbox" />
                        <span class="bf-toggle-track"><span class="bf-toggle-thumb"></span></span>
                        <span class="bf-toggle-text">AI 回复后自动更新</span>
                      </label>
                      <label class="bf-toggle">
                        <input v-model="settings.更新.自动建档" type="checkbox" />
                        <span class="bf-toggle-track"><span class="bf-toggle-thumb"></span></span>
                        <span class="bf-toggle-text">正文新角色自动建档</span>
                      </label>
                      <div class="bf-hint">开启后正文出现新角色自动建档追踪；关闭后只更新已追踪的 NPC，新角色不建档（可手动加到名单）</div>
                      <label class="bf-toggle">
                        <input v-model="settings.更新.追踪当前角色" type="checkbox" />
                        <span class="bf-toggle-track"><span class="bf-toggle-thumb"></span></span>
                        <span class="bf-toggle-text">追踪当前角色卡角色</span>
                      </label>
                      <div class="bf-hint">仅群聊时角色卡名才是角色；角色写在世界书里则保持关闭</div>
                      <label class="bf-toggle">
                        <input v-model="settings.更新.注入世界书条目" type="checkbox" />
                        <span class="bf-toggle-track"><span class="bf-toggle-thumb"></span></span>
                        <span class="bf-toggle-text">写入世界书条目（蓝灯常开）</span>
                      </label>
                      <div class="bf-hint">写入角色卡主世界书常驻条目(蓝灯常开)；切换聊天自动重写</div>
                      <label class="bf-toggle">
                        <input v-model="settings.更新.生理监测" type="checkbox" />
                        <span class="bf-toggle-track"><span class="bf-toggle-thumb"></span></span>
                        <span class="bf-toggle-text">女性NPC生理监测</span>
                      </label>
                      <div class="bf-hint">为女性NPC维护生理字段(周期/受孕/结算)，并随状态卡一同注入</div>
                      <label class="bf-toggle">
                        <input v-model="settings.更新.注入世界书" type="checkbox" />
                        <span class="bf-toggle-track"><span class="bf-toggle-thumb"></span></span>
                        <span class="bf-toggle-text">给彼方接口注入世界书内容</span>
                      </label>
                      <div class="bf-hint">按主AI方式激活世界书条目，让更新AI理解世界设定；不读全局世界书</div>
                      <textarea v-model="worldbookAlwaysDraft" class="bf-textarea bf-textarea-short" placeholder="角色名/人设条目名，如「苏禾」或「人设」"></textarea>
                      <div class="bf-hint">常驻注入：每行一个条目名/关键词，每次都强制注入(不走关键词激活)——角色人设条目通常按关键词触发，正文没提到该角色时更新AI就读不到人设；换角色卡后匹配不到会静默跳过</div>
                      <textarea v-model="worldbookExcludeDraft" class="bf-textarea bf-textarea-short" placeholder="【彼方】NPC幕后生活"></textarea>
                      <div class="bf-hint">排除不注入的世界书条目，每行一个条目名(或其关键词)，如「【彼方】NPC幕后生活」</div>
                      <div class="bf-row-pair">
                        <div class="bf-pair">
                          <span class="bf-label">更新频率</span>
                          <input v-model.number="settings.更新.更新频率" class="bf-input bf-input-num" type="number" min="1" />
                        </div>
                        <div class="bf-pair">
                          <span class="bf-label">读取回复数</span>
                          <input v-model.number="settings.更新.读取最近回复数" class="bf-input bf-input-num" type="number" min="1" max="20" />
                        </div>
                      </div>
                      <div class="bf-hint">每 N 条回复更新一次 · 更新时读取最近 N 条AI回复</div>
                    </div>

                    <div class="bf-group">
                      <div class="bf-group-title"><PhTag :size="14" weight="duotone" /> 标签过滤</div>
                      <div class="bf-row">
                        <span class="bf-label">标签模式</span>
                        <div class="bf-seg">
                          <button
                            class="bf-btn"
                            :class="{ active: settings.标签.模式 === '排除' }"
                            @click="settings.标签.模式 = '排除'"
                          >
                            排除
                          </button>
                          <button
                            class="bf-btn"
                            :class="{ active: settings.标签.模式 === '只读' }"
                            @click="settings.标签.模式 = '只读'"
                          >
                            只读
                          </button>
                        </div>
                      </div>
                      <textarea v-model="tagDraft" class="bf-textarea bf-textarea-short" placeholder="aftertalk&#10;thinking&#10;branches"></textarea>
                      <div class="bf-hint">
                        <template v-if="settings.标签.模式 === '排除'">排除这些标签内的内容，直接写标签名(如 thinking，不用尖括号)；只出现 &lt;/标签&gt; 的孤立闭合会从楼层开头删到该标签</template>
                        <template v-else>只读取这些标签内的内容；没有这些标签的楼层保留原文</template>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </Transition>
          </main>
        </div>

        <!-- Footer -->
        <footer class="bf-footer">
          <span>模型: {{ settings.接口.模型 || '—' }}</span>
          <span v-if="stats.最后更新">更新时间: {{ fmtTime(stats.最后更新) }}</span>
          <span class="bf-footer-spacer"></span>
          <span>v5.15 · 彼方</span>
        </footer>
      </div>
    </Transition>

    <!-- 添加NPC弹窗 -->
    <Transition name="bf-fade">
      <div v-if="addDialogOpen" class="bf-modal-backdrop" @click="addDialogOpen = false"></div>
    </Transition>
    <Transition name="bf-pop">
      <div v-if="addDialogOpen" class="bf-modal" @click.stop>
        <div class="bf-modal-title"><PhUserPlus :size="15" weight="duotone" /> 添加 NPC</div>
        <label class="bf-row">
          <span class="bf-label">名字</span>
          <input v-model="addDraft['名字']" class="bf-input" placeholder="NPC名字" />
        </label>
        <label v-for="字段 in 建档字段" :key="字段.名" class="bf-row">
          <span class="bf-label" :title="字段.说明">{{ 字段.名 }}</span>
          <input v-if="字段.输入 === 'input'" v-model="addDraft[字段.名]" class="bf-input" :placeholder="字段.占位 || 字段.说明" />
          <textarea v-else v-model="addDraft[字段.名]" class="bf-textarea bf-textarea-short" rows="2" :placeholder="字段.占位 || 字段.说明"></textarea>
        </label>
        <div class="bf-hint">初始状态可后续在 NPC 详情中补充或编辑（不含生理监测字段）</div>
        <div class="bf-row bf-actions">
          <button class="bf-btn bf-btn-primary" @click="confirmAddNpc"><PhCheck :size="14" weight="bold" />添加</button>
          <button class="bf-btn" @click="addDialogOpen = false">取消</button>
        </div>
      </div>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import type { Component } from 'vue';
import { storeToRefs } from 'pinia';
import {
  PhArrowsClockwise,
  PhBookmarkSimple,
  PhBrain,
  PhChatText,
  PhCheck,
  PhClipboardText,
  PhClock,
  PhCopy,
  PhFootprints,
  PhGauge,
  PhGearSix,
  PhHandshake,
  PhHeartStraight,
  PhMapPin,
  PhMoon,
  PhPaperPlaneRight,
  PhPencilSimple,
  PhPlug,
  PhPulse,
  PhScroll,
  PhShieldCheck,
  PhStarFour,
  PhSuitcaseSimple,
  PhSun,
  PhTag,
  PhTerminalWindow,
  PhTrash,
  PhUserPlus,
  PhUsers,
  PhUsersThree,
  PhWarning,
  PhX,
} from '@phosphor-icons/vue';
import { chatCompletion, fetchModelList } from './api';
import { useSettingsStore } from './settings';
import { useStateStore } from './数据仓';
import { useConsoleStore, useDebugStore, useMainPromptStore } from './日志仓';
import { useUpdatingStore } from './任务中断';
import { 加NPC, 移除NPC, 更新状态卡, 改事务状态, 清空彼方数据, 建变更环境 } from './数据变更';
import { 字段分组表, 字段说明表, 建档字段 } from './卡字段';
import type { NpcStateCard } from './卡字段';
import { 台账字段, 台账状态表, 显示台账, 状态类 } from './台账操作';
import type { 事务状态, 幕后事务 } from './事务台账';
import { updateNpcStates } from './update';
import { syncNpcStatesWorldbook } from './worldbook-inject';
import { setToastAnchor, setToastColors, toastError, toastInfo, toastSuccess, toastWarning } from './toast';
import { 取弹窗配色, 弹窗兜底配色, 弹窗变量, 悬浮球直径 } from './theme';
import type { 弹窗配色 } from './theme';
import { useHost } from './host';

// 界面入口同样是平台边界: 真实宿主在这里构造一次(适配层无状态, 只是把平台全局包一层)
const host = useHost();

const ORB_KEY = '彼方_悬浮球';
const THEME_KEY = '彼方_主题';
/** 关闭态 iframe(命中区)边长 = 球体视觉直径: 两者必须相等, 圆形裁剪才能与球完全重合——
 *  iframe 圆比球大时球会贴在 iframe 左上角, 圆心错位导致球的弧边被 iframe 圆弧切掉一块 */
const CLOSED_SIZE = 悬浮球直径;

const theme = ref<'dark' | 'light'>('dark');
try {
  const saved = host.vars.get({ type: 'global' })?.[THEME_KEY];
  if (saved === 'light' || saved === 'dark') theme.value = saved;
} catch {
  // 读取失败保持默认深色
}

function toggleTheme() {
  theme.value = theme.value === 'dark' ? 'light' : 'dark';
}

watch(theme, value => {
  try {
    host.vars.insertOrAssign({ [THEME_KEY]: value }, { type: 'global' });
  } catch {
    // 忽略保存失败
  }
  if (updatingPopEl && updatingPopEl.isConnected) {
    updatingPopEl.dataset.theme = value;
    applyPopTheme(updatingPopEl);
  }
  applyToastTheme();
});

const settingsStore = useSettingsStore();
const { settings } = storeToRefs(settingsStore);

const stateStore = useStateStore();
const { data } = storeToRefs(stateStore);

const debugStore = useDebugStore();
const { log: debugLog } = storeToRefs(debugStore);

const updatingStore = useUpdatingStore();
const { active: updatingActive, message: updatingMessage } = storeToRefs(updatingStore);

const mainPromptStore = useMainPromptStore();
const { prompt: mainPrompt, time: mainPromptTime, count: mainPromptCount } = storeToRefs(mainPromptStore);

const consoleStore = useConsoleStore();
const { lines: consoleLines } = storeToRefs(consoleStore);
const consoleLinesReversed = computed(() => [...consoleLines.value].reverse());

const rootEl = ref<HTMLElement | null>(null);
const frameWin = computed<Window | null>(() => rootEl.value?.ownerDocument?.defaultView ?? null);
const frame = computed<HTMLIFrameElement | null>(() => frameWin.value?.frameElement as HTMLIFrameElement | null);
const parentWin = computed<Window | null>(() => frameWin.value?.parent ?? null);

/**
 * 球 iframe 的**真实**视口矩形 —— 贴球定位(更新弹条/toast)的唯一锚点来源。
 *
 * 为什么不能只用 anchorX/anchorY: 那是本插件自己的逻辑球位, 而**收纳类插件(悬浮球收纳等)
 * 是直接改 iframe 本体的 style.left/top**, 且不发任何事件 —— 收纳之后逻辑锚点与真实位置脱节,
 * 弹窗会弹到"球原本应该在"的地方。iframe 的真实矩形天然跟着收纳走。
 */
const 球矩形 = ref<{ x: number; y: number; w: number; h: number; cx: number; cy: number } | null>(null);

/** 重新量球; 返回"是否变了"(没变就不惊动下游重排) */
function 量球(): boolean {
  const el = frame.value;
  if (!el || !el.isConnected) {
    球矩形.value = null;
    return false;
  }
  const r = el.getBoundingClientRect();
  if (!r.width && !r.height) {
    球矩形.value = null;
    return false;
  }
  const 旧 = 球矩形.value;
  if (旧 && Math.abs(旧.x - r.left) < 0.5 && Math.abs(旧.y - r.top) < 0.5 && Math.abs(旧.w - r.width) < 0.5 && Math.abs(旧.h - r.height) < 0.5) return false;
  球矩形.value = { x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
  return true;
}

/** 矩形盯守的两个通道: 属性观察器(瞬时命中) + 慢轮询(兜底) —— 收纳类插件不发任何事件 */
let 量球定时器: number | null = null;
let 量球观察器: MutationObserver | null = null;

/** 贴球定位的统一取点: **真实矩形优先**, 退回逻辑锚点; 半径一并给出(收纳缩放也跟得上) */
function 球锚点(): { x: number; y: number; r: number } {
  const 实 = 球矩形.value;
  if (实) return { x: 实.cx, y: 实.cy, r: Math.max(实.w, 实.h) / 2 };
  return { x: currentX(), y: currentY(), r: CLOSED_SIZE / 2 };
}

const panelOpen = ref(false);
const tab = ref<'dashboard' | 'npc' | 'consistency' | 'logs' | 'settings'>('dashboard');
const showKey = ref(false);
const fetchingModels = ref(false);
const testing = ref(false);
/** 更新进行中: 直接取自 updatingStore —— updateNpcStates 内部 start/stop 维护它,
 *  球上的转圈(updatingActive)与更新弹窗同源; 用本地 ref 会导致自动更新进行中面板按钮仍可点 */
const updating = computed(() => updatingActive.value);
const isDragging = ref(false);

// API 配置预设: 保存/加载/删除多套接口配置
const presetName = ref('');
const selectedPreset = ref('');
const presetNames = computed(() => Object.keys(settings.value.接口预设 ?? {}));
function saveApiPreset() {
  const name = String(presetName.value).trim();
  if (!name) {
    toastWarning('请填写预设名');
    return;
  }
  if (!settings.value.接口预设) settings.value.接口预设 = {};
  settings.value.接口预设[name] = klona(settings.value.接口);
  presetName.value = '';
  selectedPreset.value = name;
  toastSuccess(`已保存接口配置预设「${name}」`);
}
function loadApiPreset() {
  const name = String(selectedPreset.value).trim();
  if (!name || !settings.value.接口预设?.[name]) {
    toastWarning('请选择要加载的预设');
    return;
  }
  settings.value.接口 = klona(settings.value.接口预设[name]);
  toastSuccess(`已加载接口配置预设「${name}」`);
}
function deleteApiPreset() {
  const name = String(selectedPreset.value).trim();
  if (!name || !settings.value.接口预设?.[name]) {
    toastWarning('请选择要删除的预设');
    return;
  }
  delete settings.value.接口预设[name];
  selectedPreset.value = '';
  toastSuccess(`已删除接口配置预设「${name}」`);
}

const tabs = [
  { key: 'dashboard', icon: PhGauge, label: '仪表盘' },
  { key: 'npc', icon: PhUsers, label: 'NPC' },
  { key: 'consistency', icon: PhShieldCheck, label: '事实档案' },
  { key: 'logs', icon: PhScroll, label: '日志' },
  { key: 'settings', icon: PhGearSix, label: '设置' },
] as const;

const npcEntries = computed(() => Object.entries(data.value.NPC ?? {}));
const npcList = computed(() => data.value.名单 ?? []);
const newNpcName = ref('');
/** 自动建档开启时给空状态的正确引导; 关闭时提示手动加名单 */
const autoTrackEnabled = computed(() => settings.value.更新.自动建档 !== false);

const addDialogOpen = ref(false);
const addDraft = ref<Record<string, any>>({});

function openAddDialog() {
  addDraft.value = {
    '名字': newNpcName.value.trim(),
    '身份锚点': '',
    '当前在做': '',
    '当前状态': '',
    '位置': '',
    '接下来想做': '',
  };
  addDialogOpen.value = true;
}

function confirmAddNpc() {
  const name = String(addDraft.value['名字'] || '').trim();
  if (!name) {
    toastWarning('请填写NPC名字');
    return;
  }
  // 改数据 → 写快照 → 重同步世界书这一整套在 数据变更.ts, 界面只消费返回值
  const 结果 = 加NPC(data.value, name, addDraft.value, 建变更环境());
  data.value = 结果.数据;
  selectedNpc.value = name;
  newNpcName.value = '';
  addDialogOpen.value = false;
  toastSuccess(结果.说明);
}

function removeNpc(name: string) {
  const 结果 = 移除NPC(data.value, name, 建变更环境());
  data.value = 结果.数据;
  if (selectedNpc.value === name) selectedNpc.value = null;
}
/** 事实档案: 每个 NPC 的跨楼层记忆账本(身份锚点/未完成承诺/近期关键事件)。
 *  「未完成事项」是事务台账数组: 交给 显示台账 归一并排序(旧格式字符串也会迁移成一条进行中),
 *  模板按台账逐行渲染——直接插值数组会渲染成一串 JSON。 */
const consistencyList = computed(() => {
  const list: Array<{ name: string; 锚点?: string; 未完成事项: 幕后事务[]; 近期关键事件?: string }> = [];
  for (const [name, card] of Object.entries(data.value.NPC ?? {})) {
    const c = card as Record<string, any>;
    list.push({
      name,
      锚点: c['身份锚点'],
      未完成事项: 显示台账(c[台账字段]),
      近期关键事件: c['近期关键事件'],
    });
  }
  return list;
});
const stats = computed(() => data.value.统计 ?? { 更新次数: 0, 最后更新: 0 });
const modelList = computed(() => settings.value.接口.模型列表);
const ready = computed(() => Boolean(settings.value.接口.地址 && settings.value.接口.模型));
const statusTitle = computed(() =>
  ready.value ? `接口: ${settings.value.接口.地址} · 模型: ${settings.value.接口.模型}` : '请在「设置」中配置接口地址与模型',
);

const now = ref(Date.now());
let clockTimer: number | null = null;
const nowText = computed(() => new Date(now.value).toLocaleString());
const nowClock = computed(() => new Date(now.value).toLocaleTimeString());

const selectedNpc = ref<string | null>(null);
const selectedNpcCard = computed<NpcStateCard | null>(() => {
  if (selectedNpc.value && data.value.NPC?.[selectedNpc.value]) return data.value.NPC[selectedNpc.value];
  return null;
});

watch(
  () => data.value.NPC,
  npcMap => {
    if (!selectedNpc.value || !npcMap?.[selectedNpc.value]) {
      const first = Object.keys(npcMap ?? {})[0];
      selectedNpc.value = first ?? null;
    }
  },
  { immediate: true, deep: true },
);

function openNpc(name: string) {
  selectedNpc.value = name;
  tab.value = 'npc';
}

const editingNpc = ref(false);
const editDraft = ref<Record<string, any>>({});

function startEditNpc() {
  if (!selectedNpcCard.value) return;
  // 「未完成事项」是事务台账数组, **不进编辑表单**: 表单其余字段都是字符串, 台账的改法是在详情页
  // 用每条事务上的状态按钮(走 改事务状态 通道, 立即写快照)。不把它放进草稿有两个原因:
  //   1 表单控件按字符串处理数组会把台账显示成 [object Object] 之类, 玩家改不了还看着乱;
  //   2 草稿是打开编辑时的快照, 若台账在编辑期间被状态按钮改过, 保存时会把旧台账写回去(改动被吃掉)。
  // 草稿里没有这个字段 → 合并草稿不会碰卡里的台账(见 数据变更.ts), 不存在"悄悄丢改动"。
  const { [台账字段]: _台账, ...字符串字段 } = selectedNpcCard.value as Record<string, any>;
  editDraft.value = 字符串字段;
  editingNpc.value = true;
}

/** 详情页的事务台账(已归一、进行中在前、已办在后)——渲染用, 不写回 */
const 台账条目 = computed<幕后事务[]>(() => 显示台账((selectedNpcCard.value as Record<string, any> | null)?.[台账字段]));

/** 每行结果输入框的草稿: 没动过的行不在这里(于是沿用该条已有的结果, 见 取行结果) */
const 结果草稿 = ref<Record<string, string>>({});

/** 这一行该提交的结果: 输入框动过就用玩家写的(清空即清掉结果), 没动过就沿用台账里的 */
function 取行结果(事务: 幕后事务): string {
  const 草稿 = 结果草稿.value[事务.编号];
  return 草稿 === undefined ? String(事务.结果 ?? '') : String(草稿).trim();
}

/** 改一条事务的状态(顺带写/改结果): 走 数据变更.ts 的既有通道(写快照 + 重同步世界书)。
 *  没改成时 改事务状态 会把原数据对象原样返回——这里据此提示而不是假装成功。 */
function 改事务(事务: 幕后事务, 新状态: 事务状态) {
  if (!selectedNpc.value || !selectedNpcCard.value) return;
  const 名字 = selectedNpc.value;
  const 结果 = 改事务状态(data.value, 名字, 事务.编号, 新状态, 取行结果(事务), 建变更环境());
  if (结果.数据 === data.value) {
    toastWarning(结果.说明);
    return;
  }
  data.value = 结果.数据;
  // 提交成功后把这行的输入草稿清掉: 输入框回到"空 + 占位符显示当前结果", 免得留着一条已入库的
  // 文本让人以为还没提交(进行中不带结果, 草稿也必须跟着清)
  delete 结果草稿.value[事务.编号];
  toastSuccess(结果.说明);
}

function saveEditNpc() {
  if (!selectedNpc.value || !data.value.NPC?.[selectedNpc.value]) return;
  const 名字 = selectedNpc.value;
  // 草稿合并的规则(含"额外可编辑字段" 受孕日期/生理周期日期/怀孕知晓/孕程周数/哺乳期月数)在
  // 数据变更.ts: 有值就写、空字符串就删该字段(台账字段不在草稿里, 合并时原样保留卡里的台账)。
  // 扩展字段用于调整孕周时间线与该 NPC 种族的时间尺度。
  const 结果 = 更新状态卡(data.value, 名字, editDraft.value, 建变更环境());
  data.value = 结果.数据;
  editingNpc.value = false;
  toastSuccess(结果.说明);
}

// 开世界书注入时立即写入条目(有 NPC 才写); 关闭时删除条目。
// 数据变更之后的"重同步"由 数据变更.ts 统一负责, 这里只管"开关被拨动"这一件事。
watch(
  () => settings.value.更新.注入世界书条目,
  enabled => {
    const 写入 = enabled && Object.keys(data.value.NPC ?? {}).length > 0;
    syncNpcStatesWorldbook(host, data.value, 写入).catch(error => {
      console.error('[彼方] 同步世界书条目失败:', error);
    });
  },
);

function cancelEditNpc() {
  editingNpc.value = false;
}

function npcStatusText(card: NpcStateCard): string {
  return card['当前状态'] || card['当前在做'] || '状态未知';
}

/** NPC 详情字段分组: 分组标题与图标是展示(留在这里), "哪个字段属于哪一组"来自 卡字段.ts 的字段表 */
const 分组展示 = [
  { key: '生活', 标题: '生活动态', 图标: PhSuitcaseSimple },
  { key: '内心', 标题: '内心世界', 图标: PhBrain },
  { key: '生理', 标题: '生理状态', 图标: PhHeartStraight },
];

/** NPC 详情字段分组: 分组标题与图标是展示(留在这里), "哪个字段属于哪一组"来自 卡字段.ts 的字段表。
 *  「未完成事项」拆出去单独渲染成台账区块(它上面那排状态按钮才是它的编辑方式), 不在这里当普通字段。 */
const detailFields = computed(() =>
  分组展示
    .map(组 => ({
      ...组,
      字段: (字段分组表[组.key] || []).filter(f => f !== 台账字段 && ((selectedNpcCard.value as NpcStateCard)?.[f] || editingNpc.value)),
    }))
    .filter(组 => 组.字段.length > 0),
);

/** 折叠连续空行并去掉首尾空白，避免字段值里的多行换行造成大片空行 */
function cleanText(text: string): string {
  return (text || '').replace(/\n{3,}/g, '\n\n').trim();
}

type NpcTag = { label: string; color: string };

/** 生理周期阶段 → 标签颜色，避免所有生理标签同一个颜色太单调 */
const PHYSIOLOGY_COLORS: Record<string, string> = {
  月经期: 'red',
  卵泡期: 'blue',
  排卵期: 'orange',
  黄体期: 'yellow',
  经前期: 'pink',
  孕期: 'purple',
  哺乳期: 'teal',
};

function npcTags(card: NpcStateCard): NpcTag[] {
  const tags: NpcTag[] = [];
  const status = `${card['当前状态'] || ''} ${card['当前在做'] || ''}`;
  if (/睡|休息|就寝|午休|打盹/.test(status)) tags.push({ label: '睡眠', color: 'purple' });
  if (/工作|巡逻|食堂|任务|执勤|值班|搬运|修理|劳作|耕种|狩猎|采集|打猎|锻炼|训练|站岗/.test(status)) tags.push({ label: '工作', color: 'blue' });
  if (/吃|饭|餐|喝|用餐|就餐/.test(status)) tags.push({ label: '进食', color: 'teal' });
  if (/学习|上课|读书|复习|备考/.test(status)) tags.push({ label: '学习', color: 'teal' });
  if (/前往|走向|回家|返回|移动|离开|赶往|散步|赶路/.test(status)) tags.push({ label: '移动', color: 'orange' });
  if (/受伤|危险|流血|危机|追捕|袭击|遇袭|战斗|打斗|昏迷/.test(status)) tags.push({ label: '危险', color: 'red' });
  const ph = card['生理周期'] || '';
  if (ph) {
    const stage = ph.match(/(月经期|卵泡期|排卵期|黄体期|经前期|孕期|哺乳期)/);
    const label = stage ? stage[1] : '生理';
    tags.push({ label, color: PHYSIOLOGY_COLORS[label] ?? 'purple' });
    // 防全知: 孕期但 NPC 本人尚未确认时, 标注其认知程度(玩家上帝视角能看到幕后, 但要明白她本人不知道)
    if (stage && stage[1] === '孕期') {
      const known = String(card['怀孕知晓'] || '').trim();
      if (known === '疑似') tags.push({ label: '本人疑似', color: 'yellow' });
      else if (!known || known === '未知') tags.push({ label: '本人未察觉', color: 'gray' });
    }
  }
  return tags;
}

/** 解析 "YYYY-MM-DD HH:mm" 剧情时间为时间戳, 失败返回 null */
function storyTimeTs(text: string): number | null {
  const t = text.trim().replace(/[./]/g, '-');
  const match = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{1,2})/);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match;
  const ts = new Date(+year, +month - 1, +day, +hour, +minute).getTime();
  return Number.isNaN(ts) ? null : ts;
}

// 标签过滤草稿: 输入时原样保留(不中途拆分), watch 才把换行/分隔符解析成列表写入设置
// ——避免用 computed setter 拆分导致"一打字(换行/标点)就消失"
const tagDraft = ref(settings.value.标签.列表.join('\n'));
watch(tagDraft, value => {
  settings.value.标签.列表 = String(value ?? '')
    .split(/[\n,，;；、]+/)
    .map(item => item.trim().replace(/^<|>$/g, ''))
    .filter(Boolean);
});
// 注入世界书排除草稿: 每行一个条目名, watch 解析成列表写入设置
const worldbookExcludeDraft = ref((settings.value.更新.注入世界书排除 || []).join('\n'));
watch(worldbookExcludeDraft, value => {
  settings.value.更新.注入世界书排除 = String(value ?? '')
    .split(/[\n,，;；、]+/)
    .map(item => item.trim())
    .filter(Boolean);
});
// 常驻世界书条目草稿: 每行一个条目名/关键词, watch 解析成列表写入设置
const worldbookAlwaysDraft = ref((settings.value.更新.常驻世界书条目 || []).join('\n'));
watch(worldbookAlwaysDraft, value => {
  settings.value.更新.常驻世界书条目 = String(value ?? '')
    .split(/[\n,，;；、]+/)
    .map(item => item.trim())
    .filter(Boolean);
});

// ---- 编辑提示词功能(自定义提示词段)已于 2026-10 删除: 历史残留, 界面与设置项一并移除 ----

const savedOrb = (() => {
  try {
    return host.vars.get({ type: 'global' })?.[ORB_KEY] ?? null;
  } catch {
    return null;
  }
})();

const viewportW = (): number => parentWin.value?.innerWidth ?? window.innerWidth;
const viewportH = (): number => parentWin.value?.innerHeight ?? window.innerHeight;

/** 贴边留白: 0 = 球体真正贴到屏幕边缘(球体外侧阴影已去除, 贴边不会被裁) */
const EDGE_GAP = 0;
const halfOrb = (): number => CLOSED_SIZE / 2;
const minAnchorX = (): number => halfOrb() - EDGE_GAP;
const maxAnchorX = (): number => viewportW() - halfOrb() + EDGE_GAP;
const minAnchorY = (): number => halfOrb() - EDGE_GAP;
const maxAnchorY = (): number => viewportH() - halfOrb() + EDGE_GAP;

const anchorX = ref<number | null>(null);
const anchorY = ref<number | null>(null);

function currentX(): number {
  return anchorX.value ?? viewportW() - 40;
}

function currentY(): number {
  return anchorY.value ?? viewportH() - 110;
}

function applyFrame() {
  const target = frame.value;
  if (!target) return;
  const x = currentX();
  const y = currentY();
  if (panelOpen.value) {
    target.style.width = `${viewportW()}px`;
    target.style.height = `${viewportH()}px`;
    target.style.left = '0px';
    target.style.top = '0px';
    // 面板分支必须把圆形裁剪设回矩形圆角, 否则整个面板会被上一态的 50% 圆形裁掉
    target.style.borderRadius = '12px';
  } else {
    target.style.width = `${CLOSED_SIZE}px`;
    target.style.height = `${CLOSED_SIZE}px`;
    target.style.left = `${clamp(x - halfOrb(), -EDGE_GAP, viewportW() - CLOSED_SIZE + EDGE_GAP)}px`;
    target.style.top = `${clamp(y - halfOrb(), -EDGE_GAP, viewportH() - CLOSED_SIZE + EDGE_GAP)}px`;
    // iframe 元素本身裁成圆形(与烟火同款): replaced element 的 border-radius 会同时裁剪
    // 渲染与鼠标命中测试——四角透明方区不再存在, 隐形方框感彻底消失
    target.style.borderRadius = '50%';
  }
}

onMounted(() => {
  anchorX.value =
    typeof savedOrb?.x === 'number' && savedOrb.x >= minAnchorX() && savedOrb.x <= maxAnchorX()
      ? savedOrb.x
      : viewportW() - 40;
  anchorY.value =
    typeof savedOrb?.y === 'number' && savedOrb.y >= minAnchorY() && savedOrb.y <= maxAnchorY()
      ? savedOrb.y
      : viewportH() - 110;
  applyFrame();
  量球();
  setToastAnchor(球锚点().x, 球锚点().y);
  // 收纳类插件直接搬 iframe 本体(改内联 left/top)且不发任何事件 —— 只能自己盯住真实矩形。
  // 双通道: MutationObserver 抓属性改动(命中即瞬时), 慢轮询只作兜底。
  const 跟球 = () => {
    if (!量球()) return;
    const 锚 = 球锚点();
    setToastAnchor(锚.x, 锚.y);
    positionUpdatingPop();
  };
  if (!量球观察器 && typeof MutationObserver !== 'undefined') {
    量球观察器 = new MutationObserver(跟球);
    const 球元素 = frame.value;
    if (球元素) 量球观察器.observe(球元素, { attributes: true, attributeFilter: ['style', 'class'] });
  }
  if (量球定时器 === null) 量球定时器 = window.setInterval(跟球, 2000);
  applyToastTheme();
  parentWin.value?.addEventListener('resize', onViewportResize);
  clockTimer = window.setInterval(() => {
    now.value = Date.now();
  }, 1000);
});

onUnmounted(() => {
  if (clockTimer !== null) window.clearInterval(clockTimer);
  if (量球定时器 !== null) window.clearInterval(量球定时器);
  量球定时器 = null;
  量球观察器?.disconnect();
  量球观察器 = null;
  // 二次确认窗口与位置保存都是短定时器: 卸载后不该再回写组件状态或平台变量(定时器残留)
  if (clearConfirmTimer) clearTimeout(clearConfirmTimer);
  if (orbSaveTimer !== null) window.clearTimeout(orbSaveTimer);
});

function onViewportResize() {
  const anchorChanged = anchorX.value !== null || anchorY.value !== null;
  if (anchorX.value !== null) anchorX.value = clamp(anchorX.value, minAnchorX(), maxAnchorX());
  if (anchorY.value !== null) anchorY.value = clamp(anchorY.value, minAnchorY(), maxAnchorY());
  applyFrame();
  positionUpdatingPop();
  // 视口变化把球挤出原位置时, 保存修正后的位置
  if (anchorChanged) persistOrbPos();
}

watch([panelOpen, anchorX, anchorY], applyFrame);

// 位置持久化: 只在拖动结束(pointerup)时写一次全局变量——拖动过程中每个 pointermove
// 都写会造成数百次全局变量写入(全局变量是服务器端共享的, 每次都有序列化开销)
watch([anchorX, anchorY], () => {
  // 自己挪球: rAF 后 iframe 的真实矩形已经跟上, 取真实值(收纳挪球走 量球 的盯守通道)
  requestAnimationFrame(() => {
    量球();
    const 锚 = 球锚点();
    setToastAnchor(锚.x, 锚.y);
    positionUpdatingPop();
  });
});

let orbSaveTimer: number | null = null;
function persistOrbPos() {
  if (orbSaveTimer !== null) window.clearTimeout(orbSaveTimer);
  orbSaveTimer = window.setTimeout(() => {
    orbSaveTimer = null;
    try {
      host.vars.insertOrAssign({ [ORB_KEY]: { x: anchorX.value, y: anchorY.value } }, { type: 'global' });
    } catch {
      // 忽略保存失败
    }
  }, 200);
}

const UPDATING_POP_ID = '彼方_更新弹窗';
let updatingPopEl: HTMLElement | null = null;
/** 弹条外观(胶囊形, 与烟火更新弹条同款); 配色经 --bf-toast-* 变量跟随面板主题, 由 applyPopTheme 写入 */
const UPDATING_POP_CSS =
  `position:fixed;top:0;left:0;z-index:2147483000;display:none;align-items:center;gap:9px;padding:7px 9px 7px 15px;border-radius:999px;background:var(${弹窗变量.bg},${弹窗兜底配色.bg});border:1px solid var(${弹窗变量.border},${弹窗兜底配色.border});color:var(${弹窗变量.text},${弹窗兜底配色.text});font:12px/1.4 "Segoe UI","Microsoft YaHei",sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.45);user-select:none;white-space:nowrap;transform-origin:left center;animation:bfPopIn .32s cubic-bezier(.34,1.56,.64,1);`;
const UPDATING_POP_HTML = `
    <span class="bf-pop-spin" style="width:7px;height:7px;border-radius:50%;background:var(${弹窗变量.accent},${弹窗兜底配色.accent});display:inline-block;animation:bf-pop-spin 1.4s ease-in-out infinite;flex:none;"></span>
    <span class="bf-pop-msg"></span>
    <button type="button" class="bf-pop-cancel" style="margin-left:2px;padding:3px 11px;border-radius:999px;border:1px solid var(${弹窗变量.accent},${弹窗兜底配色.accent});background:transparent;color:var(${弹窗变量.accent},${弹窗兜底配色.accent});font:inherit;cursor:pointer;">中断</button>`;

/** 更新弹条不在弹窗容器里, 单独补主题变量 */
function applyPopTheme(el: HTMLElement) {
  const vars = 取弹窗配色(theme.value);
  for (const [key, prop] of Object.entries(弹窗变量) as [keyof 弹窗配色, string][])
    el.style.setProperty(prop, vars[key]);
}

/** 贴球弹窗容器整体同步主题配色(值来自 theme.ts, 不再从面板 DOM 里反读) */
function applyToastTheme() {
  setToastColors(取弹窗配色(theme.value));
  if (updatingPopEl && updatingPopEl.isConnected) applyPopTheme(updatingPopEl);
}

/** 弹条贴着悬浮球左方弹出(左方空间不足则弹到右方), 垂直居中对齐球, 跟随球的位置 */
function positionUpdatingPop() {
  const el = updatingPopEl;
  if (!el || !el.isConnected) return;
  const vw = viewportW();
  const vh = viewportH();
  const w = el.offsetWidth || 220;
  const h = el.offsetHeight || 42;
  // **真实矩形优先**: 收纳类插件直接搬 iframe 本体, 逻辑球位会脱节(见 球矩形)
  const 实 = 球矩形.value;
  const 心x = 实 ? 实.cx : currentX();
  const 心y = 实 ? 实.cy : currentY();
  const 半径 = 实 ? Math.max(实.w, 实.h) / 2 : CLOSED_SIZE / 2;
  let left = 心x - 半径 - w - 10;
  if (left < 8) left = 心x + 半径 + 10;
  left = clamp(left, 8, Math.max(8, vw - w - 8));
  const top = clamp(心y - h / 2, 8, Math.max(8, vh - h - 8));
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
}

function ensureUpdatingPop(doc: Document): HTMLElement {
  let el = doc.getElementById(UPDATING_POP_ID);
  if (el) {
    // 热重载/重进脚本时可能复用旧版式的残留元素: 重刷为当前样式与主题色(顺带重置旧按钮监听)
    el.style.cssText = UPDATING_POP_CSS;
    el.innerHTML = UPDATING_POP_HTML;
    applyPopTheme(el);
    return el;
  }
  el = doc.createElement('div');
  el.id = UPDATING_POP_ID;
  el.style.cssText = UPDATING_POP_CSS;
  applyPopTheme(el);
  el.innerHTML = UPDATING_POP_HTML;
  if (!doc.querySelector('style[data-bf-pop]')) {
    const style = doc.createElement('style');
    style.setAttribute('data-bf-pop', '1');
    style.textContent = `
      @keyframes bf-pop-spin{0%,100%{opacity:.35}50%{opacity:1}}
      @keyframes bfPopIn{from{opacity:0;transform:translateX(14px) scale(.9)}to{opacity:1;transform:none}}`;
    doc.head.appendChild(style);
  }
  doc.body.appendChild(el);
  return el;
}

watch([updatingActive, updatingMessage], ([active, message]) => {
  const parentDoc = parentWin.value?.document;
  if (!parentDoc) return;
  if (active) {
    updatingPopEl = ensureUpdatingPop(parentDoc);
    const msgEl = updatingPopEl.querySelector('.bf-pop-msg');
    if (msgEl) msgEl.textContent = message || '彼方更新中…';
    const cancelBtn = updatingPopEl.querySelector('.bf-pop-cancel');
    if (cancelBtn) cancelBtn.addEventListener('click', () => updatingStore.cancel());
    updatingPopEl.style.display = 'flex';
    // 重新播放弹出动画(display 切换不会重放 CSS animation)
    updatingPopEl.style.animation = 'none';
    void updatingPopEl.offsetWidth;
    updatingPopEl.style.animation = '';
    positionUpdatingPop();
  } else if (updatingPopEl && updatingPopEl.isConnected) {
    updatingPopEl.style.display = 'none';
  }
});

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

let startX = 0;
let startY = 0;
let startAnchorX = 0;
let startAnchorY = 0;
let moved = false;

function parentClient(e: PointerEvent): { x: number; y: number } {
  const rect = frame.value?.getBoundingClientRect();
  if (e.view === frameWin.value && rect) {
    return { x: rect.left + e.clientX, y: rect.top + e.clientY };
  }
  return { x: e.clientX, y: e.clientY };
}

function onOrbPointerDown(e: PointerEvent) {
  e.preventDefault();
  isDragging.value = true;
  moved = false;
  const rect = frame.value?.getBoundingClientRect();
  startX = (rect?.left ?? 0) + e.clientX;
  startY = (rect?.top ?? 0) + e.clientY;
  startAnchorX = currentX();
  startAnchorY = currentY();
  frameWin.value?.addEventListener('pointermove', onMove);
  frameWin.value?.addEventListener('pointerup', onUp);
  parentWin.value?.addEventListener('pointermove', onMove);
  parentWin.value?.addEventListener('pointerup', onUp);
}

function onMove(e: PointerEvent) {
  const point = parentClient(e);
  if (Math.abs(point.x - startX) + Math.abs(point.y - startY) > 4) moved = true;
  anchorX.value = clamp(startAnchorX + (point.x - startX), minAnchorX(), maxAnchorX());
  anchorY.value = clamp(startAnchorY + (point.y - startY), minAnchorY(), maxAnchorY());
}

function onUp() {
  isDragging.value = false;
  frameWin.value?.removeEventListener('pointermove', onMove);
  frameWin.value?.removeEventListener('pointerup', onUp);
  parentWin.value?.removeEventListener('pointermove', onMove);
  parentWin.value?.removeEventListener('pointerup', onUp);
  if (moved) persistOrbPos();
  window.setTimeout(() => {
    moved = false;
  }, 200);
}

function onOrbClick() {
  if (moved) {
    moved = false;
    return;
  }
  panelOpen.value = !panelOpen.value;
}

function closePanel() {
  panelOpen.value = false;
}

function fmtTime(timestamp?: number): string {
  return timestamp ? new Date(timestamp).toLocaleString() : '';
}

async function copyText(text: string) {
  // iframe 内 navigator.clipboard 常被权限策略禁用，优先用父窗口的剪贴板
  const clipboard = parentWin.value?.navigator.clipboard ?? navigator.clipboard;
  if (clipboard && typeof clipboard.writeText === 'function') {
    try {
      await clipboard.writeText(text);
      toastSuccess('已复制到剪贴板');
      return;
    } catch {
      // 继续走兜底
    }
  }
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const ok = document.execCommand('copy');
    textarea.remove();
    if (ok) {
      toastSuccess('已复制到剪贴板');
      return;
    }
  } catch {
    // 忽略
  }
  toastError('复制失败，请手动选中复制');
}

function buildErrorReport(): string {
  const log = debugLog.value;
  if (!log) return '';
  return [
    '【彼方 · 报错报告】',
    `时间: ${fmtTime(log.time)}`,
    `模型: ${log.model || '—'}`,
    `使用的楼层: #${log.replyIds.length > 0 ? log.replyIds.join('、#') : '—'}`,
    `本轮更新NPC: ${log.updatedNpcs.join('、') || '—'}`,
    log.error ? `错误: ${log.error}` : '',
    '',
    '--- 发送给 AI 的内容 ---',
    log.request,
    '',
    '--- AI 输出内容 ---',
    log.response || '(无输出)',
  ]
    .filter(line => line !== '')
    .join('\n');
}

async function copyErrorReport() {
  await copyText(buildErrorReport());
}

async function loadModels() {
  if (!settings.value.接口.地址) {
    toastWarning('请先填写接口地址');
    return;
  }
  fetchingModels.value = true;
  try {
    const list = await fetchModelList();
    settings.value.接口.模型列表 = list;
    if (!list.includes(settings.value.接口.模型)) {
      settings.value.接口.模型 = list[0] ?? '';
    }
    toastSuccess(`获取到 ${list.length} 个模型`);
  } catch (error) {
    console.error('[彼方] 获取模型列表失败:', error);
    toastError(error instanceof Error ? error.message : String(error), '彼方·获取模型失败');
  } finally {
    fetchingModels.value = false;
  }
}

async function testConnection() {
  if (!settings.value.接口.地址 || !settings.value.接口.模型) {
    toastWarning('请先填写接口地址并选择模型');
    return;
  }
  testing.value = true;
  try {
    const reply = await chatCompletion([{ role: 'user', content: '请只回复两个字: 正常' }], { max_tokens: 16 });
    toastSuccess(`连接正常, 模型回复: ${reply.trim().slice(0, 50)}`);
  } catch (error) {
    console.error('[彼方] 测试连接失败:', error);
    toastError(error instanceof Error ? error.message : String(error), '彼方·测试失败');
  } finally {
    testing.value = false;
  }
}

async function manualUpdate() {
  if (!settings.value.启用幕后) {
    toastWarning('幕后系统已关闭(设置→启用幕后), 如需更新请先开启');
    return;
  }
  await updateNpcStates(true);
}

function reload() {
  stateStore.reload();
}

const clearing = ref(false);
/** 「再点一次确认清空」的确认窗口定时器: 确认或重新计时前必须先清掉旧的——
 *  否则上一次的定时器会在新确认窗口中途把 clearing 提前复位, 玩家第二次点击就变成"重新计时"而不是清空 */
let clearConfirmTimer: ReturnType<typeof setTimeout> | null = null;

function clearAll() {
  if (!clearing.value) {
    clearing.value = true;
    if (clearConfirmTimer) clearTimeout(clearConfirmTimer);
    clearConfirmTimer = setTimeout(() => {
      clearing.value = false;
    }, 3000);
    return;
  }
  clearing.value = false;
  if (clearConfirmTimer) {
    clearTimeout(clearConfirmTimer);
    clearConfirmTimer = null;
  }
  // 清空 = 物理删除所有楼层的快照 + 重置元数据(记录清空层) + 删掉世界书条目——协议在 数据变更.ts;
  // 这里不再重读存储做启发式校验(持久层自己负责正确性, 失败会记录日志)
  const 结果 = 清空彼方数据(建变更环境());
  data.value = 结果.数据;
  toastSuccess(结果.说明);
}
</script>

<style scoped>
.bf-root {
  position: fixed;
  inset: 0;
  width: 100vw;
  height: 100vh;
  overflow: hidden;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
  user-select: none;
  /* 深色主题 (默认) —— 夜幕暖灯：深蓝黑夜幕底 + 暖黄灯光点缀 + 月白文字
     具体色值统一写在 theme.ts(一份数据同时生成这里的变量与弹窗配色), 这里不再列一遍 */
  color-scheme: dark;
  color: var(--bf-text);
}

/* 白天模式 —— 冷白月光基底，琥珀灯光点缀(token 值见 theme.ts) */
.bf-root[data-theme='light'] {
  color-scheme: light;
}

/* ---------- 悬浮球 (深色星盘 + 细环 + 渐变描边星) ---------- */
.bf-orb {
  position: absolute;
  /* 定位由内联样式控制: 关闭时 left/top=0 填满圆形 iframe, 打开时=锚点-20 (相对全屏 iframe)。
     不用 left:50%+translate 居中——打开态内联 left/top 会与 translate 叠加导致球跳动 */
  width: 40px;
  height: 40px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: grab;
  border: none;
  background:
    radial-gradient(circle at 50% 40%, var(--bf-accent-soft), transparent 62%),
    var(--bf-orb-bg);
  box-shadow:
    inset 0 0 0 1px var(--bf-orb-ring),
    inset 0 1px 0 rgba(255, 255, 255, 0.1);
  color: var(--bf-accent);
  transition: box-shadow 0.25s ease;
  touch-action: none;
}
/* hover/拖动不放大球体(放大会被 40px 命中框裁剪出方形边缘), 改为黄色边线发光:
   内环加亮加粗 + 内侧泛光, 全部用 inset 阴影实现, 不会被 iframe 边缘裁掉 */
.bf-orb:hover {
  box-shadow:
    inset 0 0 0 2px var(--bf-orb-ring-strong),
    inset 0 0 9px var(--bf-orb-ring-strong),
    inset 0 1px 0 rgba(255, 255, 255, 0.14);
}
.bf-orb.dragging {
  cursor: grabbing;
  box-shadow:
    inset 0 0 0 2px var(--bf-orb-ring-strong),
    inset 0 0 12px var(--bf-orb-ring-strong),
    inset 0 1px 0 rgba(255, 255, 255, 0.14);
}
.bf-orb-icon {
  width: 22px;
  height: 22px;
  filter: drop-shadow(0 1px 2px rgba(4, 8, 5, 0.45));
}
.bf-orb-comp {
  position: absolute;
  right: 6px;
  bottom: 6px;
  width: 9px;
  height: 9px;
  color: var(--bf-orb-comp);
  transition: color 0.18s ease;
}
.bf-orb:hover .bf-orb-comp {
  color: var(--bf-accent);
}
.bf-orb-spinner {
  position: absolute;
  right: 0;
  bottom: 0;
  width: 13px;
  height: 13px;
  border: 2px solid var(--bf-border-strong);
  border-top-color: var(--bf-accent);
  border-radius: 50%;
  animation: bf-spin 0.8s linear infinite;
}

.bf-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(6, 12, 8, 0.5);
  backdrop-filter: blur(3px);
  z-index: 1;
}
.bf-root[data-theme='light'] .bf-backdrop {
  background: rgba(46, 42, 34, 0.28);
}

/* ---------- 面板 (居中固定大小窗口) ---------- */
.bf-panel {
  position: fixed;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  width: min(1080px, 95vw);
  height: min(760px, 92vh);
  z-index: 2;
  display: flex;
  flex-direction: column;
  background: var(--bf-bg);
  border-radius: var(--bf-radius-lg);
  overflow: hidden;
  border: 1px solid var(--bf-border-strong);
  box-shadow: var(--bf-shadow);
}

/* ---------- Header ---------- */
.bf-header {
  position: relative;
  height: 56px;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 0 18px;
  background: linear-gradient(180deg, var(--bf-bg2), var(--bf-bg));
  border-bottom: 1px solid var(--bf-border);
}
/* 顶部暖光氛围带 —— 深夜房间里那盏灯 */
.bf-header::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 2px;
  background: linear-gradient(90deg, transparent, var(--bf-accent-soft), var(--bf-accent), var(--bf-accent-soft), transparent);
  opacity: 0.7;
}
.bf-brand {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: none;
}
.bf-logo {
  width: 36px;
  height: 36px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  background:
    radial-gradient(circle at 50% 30%, var(--bf-accent-soft), transparent 72%),
    var(--bf-bg2);
  border: 1px solid var(--bf-border-strong);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08);
  color: var(--bf-accent);
}
.bf-logo svg {
  width: 22px;
  height: 22px;
}
.bf-brand-text {
  line-height: 1.2;
}
.bf-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--bf-text);
}
.bf-title-en {
  margin-left: 6px;
  font-size: 11px;
  font-weight: 500;
  color: var(--bf-dim);
  letter-spacing: 0.06em;
}
.bf-subtitle {
  font-size: 11px;
  color: var(--bf-dim);
}

/* ---------- 顶部导航栏 ---------- */
.bf-navbar {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: 1;
  justify-content: center;
  min-width: 0;
  overflow-x: auto;
  padding: 0 8px;
}
.bf-nav {
  position: relative;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 8px 13px;
  border: none;
  border-radius: var(--bf-radius-sm);
  background: transparent;
  color: var(--bf-dim);
  font-size: 13px;
  cursor: pointer;
  transition: background 0.16s ease, color 0.16s ease;
  white-space: nowrap;
}
.bf-nav:hover {
  background: var(--bf-hover);
  color: var(--bf-text);
}
.bf-nav.active {
  background: var(--bf-accent-soft);
  color: var(--bf-accent-text);
}
.bf-nav.active::after {
  content: '';
  position: absolute;
  left: 12px;
  right: 12px;
  bottom: 2px;
  height: 2px;
  border-radius: 2px;
  background: var(--bf-accent);
}
.bf-nav-icon {
  width: 17px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
}

.bf-header-right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
}
.bf-ready {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--bf-dim);
}
.bf-ready .bf-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--bf-danger);
}
.bf-ready.ok .bf-dot {
  background: var(--bf-success);
  box-shadow: 0 0 6px var(--bf-success);
}
.bf-clock {
  font-size: 12px;
  color: var(--bf-dim);
  font-variant-numeric: tabular-nums;
}
.bf-icon-btn {
  width: 30px;
  height: 30px;
  border: none;
  border-radius: var(--bf-radius-sm);
  background: transparent;
  color: var(--bf-dim);
  font-size: 14px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: background 0.16s ease, color 0.16s ease;
}
.bf-icon-btn:hover {
  background: var(--bf-hover);
  color: var(--bf-text);
}
.bf-theme-btn:hover {
  background: var(--bf-accent-soft);
  color: var(--bf-accent-text);
}

/* ---------- Body ---------- */
.bf-body {
  flex: 1;
  display: flex;
  min-height: 0;
}

/* ---------- 主内容 ---------- */
.bf-main {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 22px 26px;
}
.bf-page {
  max-width: 980px;
  margin: 0 auto;
}
.bf-page-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 18px;
  font-weight: 700;
  color: var(--bf-text);
  margin-bottom: 18px;
  letter-spacing: 0.01em;
}
.bf-page-title svg {
  color: var(--bf-accent-text);
}
.bf-page-title .bf-btn {
  margin-left: auto;
  flex: none;
}

/* ---------- 仪表盘双栏布局 ---------- */
.bf-dash-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 210px;
  gap: 14px;
  align-items: start;
}
.bf-dash-main {
  min-width: 0;
}
.bf-dash-side {
  display: flex;
  flex-direction: column;
  gap: 10px;
  position: sticky;
  top: 0;
}
.bf-side-card {
  background: var(--bf-card);
  border: 1px solid var(--bf-border);
  border-radius: var(--bf-radius);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  transition: background 0.16s ease, transform 0.16s ease, border-color 0.16s ease;
}
.bf-side-card:hover {
  background: var(--bf-hover);
  border-color: var(--bf-border-strong);
  transform: translateY(-1px);
}
.bf-side-num {
  font-size: 26px;
  font-weight: 700;
  color: var(--bf-text);
  font-variant-numeric: tabular-nums;
  line-height: 1.1;
}
.bf-side-num.bf-side-clock {
  font-size: 15px;
  font-weight: 600;
  line-height: 1.1;
}
.bf-side-label {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11.5px;
  color: var(--bf-dim);
}
.bf-side-label svg {
  color: var(--bf-accent-text);
}
.bf-panel-card-count {
  margin-left: auto;
  font-size: 11px;
  font-weight: 600;
  color: var(--bf-accent-text);
  background: var(--bf-accent-soft);
  border-radius: 999px;
  padding: 2px 9px;
}

/* ---------- 日志双栏布局 ---------- */
.bf-logs-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 14px;
  align-items: start;
}
.bf-logs-main,
.bf-logs-side {
  min-width: 0;
}

/* ---------- 设置页双栏布局 ---------- */
.bf-settings-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 18px;
  align-items: start;
}
.bf-settings-main,
.bf-settings-side {
  min-width: 0;
}
@media (max-width: 880px) {
  .bf-settings-layout {
    grid-template-columns: 1fr;
  }
}

/* ---------- 操作按钮行 ---------- */
.bf-dash-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 16px;
}
.bf-panel-card {
  background: var(--bf-card);
  border: 1px solid var(--bf-border);
  border-radius: var(--bf-radius);
  padding: 16px;
  margin-bottom: 14px;
}
.bf-panel-card-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--bf-text);
  margin-bottom: 12px;
}
.bf-panel-card-title svg {
  color: var(--bf-accent-text);
}
.bf-dash-npcs {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 8px;
}
.bf-dash-npc {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: var(--bf-radius-sm);
  background: var(--bf-bg2);
  border: 1px solid var(--bf-border);
  cursor: pointer;
  transition: background 0.16s ease, border-color 0.16s ease;
  min-width: 0;
}
.bf-dash-npc:hover {
  background: var(--bf-hover);
  border-color: var(--bf-border-strong);
}
.bf-dash-npc-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.bf-dash-npc-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--bf-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bf-dash-npc-loc {
  font-size: 10.5px;
  color: var(--bf-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bf-npc-del {
  margin-left: 2px;
  width: 22px;
  height: 22px;
  font-size: 11px;
  border-radius: 6px;
  flex: none;
}
.bf-npc-del:hover {
  background: rgba(212, 132, 111, 0.2);
  color: var(--bf-danger);
}

/* ---------- 通用组件 ---------- */
.bf-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 14px;
  border: 1px solid var(--bf-border);
  border-radius: var(--bf-radius-sm);
  background: var(--bf-card);
  color: var(--bf-text);
  font-size: 13px;
  cursor: pointer;
  transition: background 0.16s ease, border-color 0.16s ease;
}
.bf-btn:hover:not(:disabled) {
  background: var(--bf-hover);
  border-color: var(--bf-border-strong);
}
.bf-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.bf-btn-primary {
  background: var(--bf-accent-strong);
  border-color: transparent;
  color: #ffffff;
}
.bf-btn-primary:hover:not(:disabled) {
  background: var(--bf-accent);
  color: #ffffff;
}
.bf-btn-danger {
  background: rgba(212, 132, 111, 0.12);
  border-color: rgba(212, 132, 111, 0.4);
  color: var(--bf-danger);
}
.bf-btn-danger:hover:not(:disabled) {
  background: rgba(212, 132, 111, 0.22);
}
.bf-btn-sm {
  padding: 5px 12px;
  font-size: 12px;
}
.bf-btn-mini {
  padding: 3px 10px;
  font-size: 11px;
  border-radius: 6px;
}
.bf-btn.active {
  background: var(--bf-accent-strong);
  border-color: transparent;
  color: #ffffff;
}
.bf-spinner {
  width: 13px;
  height: 13px;
  border: 2px solid var(--bf-border-strong);
  border-top-color: currentColor;
  border-radius: 50%;
  animation: bf-spin 0.8s linear infinite;
  display: inline-block;
  flex: none;
}

.bf-avatar {
  width: 34px;
  height: 34px;
  border-radius: var(--bf-radius-sm);
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  font-weight: 600;
  color: #ffffff;
  background: linear-gradient(145deg, var(--bf-accent), var(--bf-accent-strong));
}
.bf-avatar-lg {
  width: 44px;
  height: 44px;
  font-size: 18px;
  border-radius: var(--bf-radius);
}

.bf-tag {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 10.5px;
  font-weight: 500;
  line-height: 1.5;
}
.bf-tag-green {
  background: rgba(143, 191, 127, 0.16);
  color: var(--bf-success);
}
.bf-tag-yellow {
  background: rgba(251, 191, 36, 0.16);
  color: var(--bf-warning);
}
.bf-tag-blue {
  background: rgba(96, 165, 250, 0.16);
  color: #60a5fa;
}
.bf-tag-purple {
  background: rgba(192, 132, 252, 0.16);
  color: #c084fc;
}
.bf-tag-pink {
  background: rgba(244, 114, 182, 0.16);
  color: #f472b6;
}
.bf-tag-teal {
  background: rgba(110, 192, 178, 0.16);
  color: #5fb4a2;
}
.bf-tag-orange {
  background: rgba(251, 146, 60, 0.16);
  color: #fb923c;
}
.bf-tag-red {
  background: rgba(248, 113, 113, 0.16);
  color: #f87171;
}
/* 白天模式下标签文字加深以通过对比度 */
.bf-root[data-theme='light'] .bf-tag-green {
  color: #059669;
}
.bf-root[data-theme='light'] .bf-tag-yellow {
  color: #b45309;
}
.bf-root[data-theme='light'] .bf-tag-blue {
  color: #2563eb;
}
.bf-root[data-theme='light'] .bf-tag-purple {
  color: #9333ea;
}
.bf-root[data-theme='light'] .bf-tag-pink {
  color: #db2777;
}
.bf-root[data-theme='light'] .bf-tag-teal {
  color: #2c8a78;
}
.bf-root[data-theme='light'] .bf-tag-orange {
  color: #ea580c;
}
.bf-root[data-theme='light'] .bf-tag-red {
  color: #dc2626;
}

.bf-empty {
  padding: 40px 20px;
  text-align: center;
  color: var(--bf-dim);
}
.bf-empty-text {
  font-size: 14px;
  color: var(--bf-text);
  margin-bottom: 6px;
}
.bf-empty-hint {
  font-size: 12px;
  color: var(--bf-dim);
}

/* ---------- NPC Master-Detail ---------- */
.bf-npc-layout {
  display: flex;
  gap: 14px;
  max-width: 1000px;
  height: calc(min(760px, 92vh) - 128px);
  min-height: 360px;
}
.bf-npc-list {
  width: 260px;
  flex: none;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-right: 2px;
}
.bf-npc-item {
  display: flex;
  gap: 10px;
  padding: 10px 12px;
  border-radius: var(--bf-radius);
  background: var(--bf-card);
  border: 1px solid var(--bf-border);
  cursor: pointer;
  transition: background 0.16s ease, border-color 0.16s ease;
}
.bf-npc-item:hover {
  background: var(--bf-hover);
}
.bf-npc-item.active {
  border-color: var(--bf-accent);
  background: var(--bf-accent-soft);
}
.bf-npc-item-main {
  min-width: 0;
  flex: 1;
}
.bf-npc-item-top {
  display: flex;
  align-items: center;
  gap: 6px;
}
.bf-npc-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--bf-text);
}
.bf-online-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--bf-success);
  box-shadow: 0 0 5px var(--bf-success);
  flex: none;
}
.bf-npc-sub {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--bf-dim);
  margin-top: 2px;
  overflow: hidden;
}
.bf-npc-sub .bf-npc-loc {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  flex: none;
}
.bf-npc-sub .bf-npc-loc svg {
  color: var(--bf-accent-text);
}
.bf-npc-sub .bf-npc-loc-text {
  max-width: 70px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bf-npc-sub .bf-npc-sep {
  flex: none;
  opacity: 0.5;
}
.bf-npc-sub .bf-npc-status {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bf-npc-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 5px;
}
.bf-npc-detail {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  background: var(--bf-card);
  border: 1px solid var(--bf-border);
  border-radius: var(--bf-radius);
  padding: 18px;
}
.bf-detail-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--bf-border);
  margin-bottom: 14px;
}
.bf-detail-actions {
  display: flex;
  gap: 6px;
  margin-left: 8px;
}

/* ---------- 弹窗 ---------- */
.bf-modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(6, 12, 8, 0.5);
  backdrop-filter: blur(2px);
  z-index: 20;
}
.bf-root[data-theme='light'] .bf-modal-backdrop {
  background: rgba(43, 51, 64, 0.28);
}
.bf-modal {
  position: fixed;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  width: min(440px, 90vw);
  max-height: 86vh;
  overflow-y: auto;
  background: var(--bf-bg2);
  border: 1px solid var(--bf-border);
  border-radius: var(--bf-radius-lg);
  padding: 18px;
  z-index: 21;
  box-shadow: var(--bf-shadow);
}
.bf-modal-title {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 15px;
  font-weight: 700;
  color: var(--bf-text);
  margin-bottom: 14px;
}
.bf-modal-title svg {
  color: var(--bf-accent-text);
}
.bf-detail-head-text {
  flex: 1;
}
.bf-detail-name {
  font-size: 18px;
  font-weight: 700;
  color: var(--bf-text);
}
.bf-detail-updated {
  font-size: 11px;
  color: var(--bf-dim);
}
.bf-detail-fields {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px 16px;
}
.bf-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

/* ---------- NPC 详情：核心状态区 ---------- */
.bf-detail-spotlight {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 16px;
}
.bf-spot {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  padding: 12px 14px;
  background: var(--bf-bg2);
  border: 1px solid var(--bf-border);
  border-radius: var(--bf-radius);
}
.bf-spot:hover {
  background: var(--bf-hover);
}
.bf-spot-icon {
  width: 32px;
  height: 32px;
  flex: none;
  border-radius: var(--bf-radius-sm);
  background: var(--bf-accent-soft);
  color: var(--bf-accent-text);
  display: flex;
  align-items: center;
  justify-content: center;
}
.bf-spot-main {
  flex: 1;
  min-width: 0;
}
.bf-spot-label {
  display: block;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.06em;
  color: var(--bf-dim);
  margin-bottom: 3px;
  text-transform: uppercase;
}
.bf-spot-value {
  font-size: 14px;
  color: var(--bf-text);
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}
.bf-spot-value-loc {
  font-size: 13px;
}
.bf-spot .bf-textarea {
  min-height: 40px;
}

/* ---------- NPC 详情：分组字段 ---------- */
.bf-detail-groups {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.bf-field-group {
  background: var(--bf-bg2);
  border: 1px solid var(--bf-border);
  border-radius: var(--bf-radius);
  padding: 12px 14px;
}
.bf-field-group-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--bf-accent-text);
  margin-bottom: 10px;
}
.bf-field-group-title svg {
  color: var(--bf-accent-text);
}
.bf-field-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px 16px;
}
.bf-field-value-bool {
  font-size: 13px;
}
.bf-field-label {
  font-size: 11px;
  color: var(--bf-dim);
  font-weight: 500;
}
.bf-field-value {
  font-size: 13px;
  color: var(--bf-text);
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}


/* ---------- 事实档案 ---------- */
.bf-page-hint {
  font-size: 12px;
  color: var(--bf-dim);
  margin: -4px 0 14px;
  line-height: 1.6;
  opacity: 0.85;
}
.bf-consistency-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.bf-consistency-card {
  padding: 14px 16px;
}
.bf-consistency-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 10px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--bf-border);
}
.bf-consistency-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--bf-text);
}
.bf-consistency-anchor {
  font-size: 12px;
  color: var(--bf-accent);
  opacity: 0.9;
}
.bf-consistency-grid {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.bf-consistency-row {
  display: grid;
  grid-template-columns: 110px 1fr;
  gap: 10px;
  font-size: 12.5px;
  line-height: 1.6;
  align-items: start;
}
.bf-consistency-label {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--bf-dim);
  font-weight: 500;
  flex-shrink: 0;
}
.bf-consistency-value {
  color: var(--bf-text);
  white-space: pre-wrap;
  word-break: break-word;
}
.bf-consistency-empty .bf-consistency-value {
  color: var(--bf-dim);
  opacity: 0.6;
  font-style: italic;
}

/* ---------- 事务台账(「未完成事项」) ---------- */
.bf-ledger {
  background: var(--bf-bg2);
  border: 1px solid var(--bf-border);
  border-radius: var(--bf-radius);
  padding: 12px 14px;
  margin-bottom: 16px;
}
.bf-ledger-head {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 4px 10px;
  margin-bottom: 10px;
}
.bf-ledger-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--bf-accent-text);
}
.bf-ledger-hint {
  font-size: 11px;
  color: var(--bf-dim);
  opacity: 0.75;
}
.bf-ledger-blank {
  font-size: 12.5px;
  color: var(--bf-dim);
  opacity: 0.6;
  font-style: italic;
}
.bf-ledger-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
/* 一条事务一块: 进行中左侧亮一道强调色(醒目), 已完成/已作废整体压暗(弱化) */
.bf-ledger-item {
  background: var(--bf-card);
  border: 1px solid var(--bf-border);
  border-left: 3px solid var(--bf-border);
  border-radius: var(--bf-radius-sm);
  padding: 8px 10px;
}
.bf-ledger-item.is-ongoing {
  border-left-color: var(--bf-accent);
}
.bf-ledger-item.is-done,
.bf-ledger-item.is-void {
  opacity: 0.62;
}
.bf-ledger-row {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 6px 8px;
  font-size: 12.5px;
  line-height: 1.6;
}
.bf-ledger-no {
  flex: none;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--bf-accent-text);
}
.bf-ledger-time {
  flex: none;
  font-size: 11px;
  color: var(--bf-dim);
}
.bf-ledger-content {
  color: var(--bf-text);
  word-break: break-word;
}
.bf-ledger-resulttext {
  margin-top: 3px;
  font-size: 11.5px;
  color: var(--bf-text);
  opacity: 0.8;
  word-break: break-word;
}
/* 状态徽章: 三个状态一套形状, 只有颜色不同(进行中用强调色, 已完成用成功色, 已作废用危险色) */
.bf-ledger-state {
  flex: none;
  display: inline-block;
  font-size: 10.5px;
  line-height: 1.6;
  padding: 0 7px;
  border-radius: 999px;
  border: 1px solid var(--bf-border-strong);
  color: var(--bf-dim);
  white-space: nowrap;
}
.bf-ledger-state.is-ongoing {
  border-color: transparent;
  background: var(--bf-accent-soft);
  color: var(--bf-accent-text);
}
.bf-ledger-state.is-done {
  border-color: transparent;
  color: var(--bf-success);
}
.bf-ledger-state.is-void {
  border-color: transparent;
  color: var(--bf-danger);
}
.bf-ledger-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 7px;
}
/* 选择器带上 .bf-ledger 前缀: 通用组件(.bf-input/.bf-seg)在这份样式里排在后面, 不加前缀会被它们盖掉 */
.bf-ledger .bf-ledger-result {
  flex: 1;
  min-width: 0;
  height: 28px;
  font-size: 11.5px;
}
.bf-ledger .bf-ledger-seg {
  flex: none;
}
.bf-ledger .bf-ledger-seg .bf-btn {
  padding: 4px 9px;
  font-size: 11px;
}
/* 事实档案页里的只读台账行(与详情页共用 .bf-ledger-no / .bf-ledger-state) */
.bf-consistency-ledger {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.bf-ledger-line {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 4px 6px;
  font-size: 12px;
  line-height: 1.55;
}
.bf-ledger-line.is-done,
.bf-ledger-line.is-void {
  opacity: 0.62;
}
.bf-ledger-line-text {
  word-break: break-word;
}

/* ---------- 日志 ---------- */
.bf-debug-meta {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.bf-debug-meta-row {
  display: flex;
  align-items: baseline;
  gap: 10px;
  font-size: 12.5px;
  color: var(--bf-text);
}
.bf-debug-meta-label {
  width: 76px;
  flex: none;
  font-size: 11.5px;
  color: var(--bf-dim);
}
.bf-debug-preview {
  color: var(--bf-text);
  opacity: 0.85;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bf-debug-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--bf-text);
}
.bf-debug-head-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.bf-debug-head-section {
  font-size: 14px;
  font-weight: 700;
  margin: 0 0 10px;
  color: var(--bf-text);
}
.bf-debug-summary {
  font-size: 12px;
  color: var(--bf-dim);
  cursor: pointer;
  padding: 6px 8px;
  border-radius: var(--bf-radius-sm);
  background: var(--bf-bg2);
  transition: background 0.16s ease;
}
.bf-debug-summary:hover {
  background: var(--bf-hover);
}
.bf-debug-pre {
  margin-top: 8px;
  padding: 12px;
  border-radius: var(--bf-radius-sm);
  background: var(--bf-code);
  border: 1px solid var(--bf-border);
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--bf-text);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 420px;
  overflow-y: auto;
  font-family: 'JetBrains Mono', 'SF Mono', Consolas, monospace;
}
.bf-debug-error .bf-debug-pre {
  border-color: rgba(212, 132, 111, 0.4);
  color: var(--bf-danger);
}

/* ---------- 控制台输出 ---------- */
.bf-console {
  max-height: 320px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
  background: var(--bf-code);
  border: 1px solid var(--bf-border);
  border-radius: var(--bf-radius-sm);
  padding: 8px;
}
.bf-console-line {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 11.5px;
  line-height: 1.5;
  font-family: 'JetBrains Mono', 'SF Mono', Consolas, monospace;
  word-break: break-word;
}
.bf-console-time {
  flex: none;
  color: var(--bf-dim);
  font-size: 10.5px;
}
.bf-console-log .bf-console-text {
  color: var(--bf-text);
}
.bf-console-info .bf-console-text {
  color: var(--bf-accent-text);
}
.bf-console-warn .bf-console-text {
  color: var(--bf-warning);
}
.bf-console-error .bf-console-text {
  color: var(--bf-danger);
}

/* ---------- 设置 ---------- */
.bf-group {
  background: var(--bf-card);
  border: 1px solid var(--bf-border);
  border-radius: var(--bf-radius);
  padding: 18px;
  margin-bottom: 18px;
}
.bf-group-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 700;
  letter-spacing: 0.01em;
  color: var(--bf-text);
  margin-bottom: 16px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--bf-border);
}
.bf-group-title svg {
  color: var(--bf-accent-text);
}
.bf-group-subtitle {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 20px 0 14px;
  padding-top: 16px;
  border-top: 1px solid var(--bf-border);
  font-size: 11.5px;
  font-weight: 700;
  letter-spacing: 0.14em;
  color: var(--bf-dim);
  white-space: nowrap;
}
.bf-group-subtitle::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--bf-border);
}
.bf-group-subtitle:first-child {
  margin-top: 0;
  padding-top: 0;
  border-top: none;
}

/* 表单行: 标签左固定、控件弹性, 统一 12px 行距 */
.bf-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 12px;
}
.bf-row > .bf-label:first-child {
  min-width: 96px;
}
.bf-label {
  font-size: 12.5px;
  color: var(--bf-dim);
  flex: none;
  min-width: 84px;
}
/* 一行两个字段(如 温度/最大Token) */
.bf-row-pair {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
  margin-bottom: 12px;
}
.bf-row-pair .bf-pair {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.bf-row-pair .bf-pair .bf-label {
  min-width: 0;
  flex: none;
}
.bf-input {
  flex: 1;
  min-width: 130px;
  height: 34px;
  padding: 0 11px;
  border-radius: var(--bf-radius-sm);
  border: 1px solid var(--bf-border);
  background: var(--bf-bg2);
  color: var(--bf-text);
  font-size: 13px;
  outline: none;
  transition: border-color 0.16s ease, box-shadow 0.16s ease;
}
.bf-input:focus {
  border-color: var(--bf-accent);
  box-shadow: 0 0 0 3px var(--bf-accent-soft);
}
.bf-input::placeholder {
  color: var(--bf-faint);
}
.bf-input-num {
  flex: none;
  width: 92px;
  min-width: 0;
  text-align: center;
}
.bf-actions {
  gap: 8px;
}
.bf-textarea {
  width: 100%;
  padding: 10px 12px;
  border-radius: var(--bf-radius-sm);
  border: 1px solid var(--bf-border);
  background: var(--bf-bg2);
  color: var(--bf-text);
  font-size: 13px;
  line-height: 1.5;
  outline: none;
  resize: vertical;
  font-family: inherit;
  box-sizing: border-box;
  transition: border-color 0.16s ease, box-shadow 0.16s ease;
}
.bf-textarea:focus {
  border-color: var(--bf-accent);
  box-shadow: 0 0 0 3px var(--bf-accent-soft);
}
.bf-textarea::placeholder {
  color: var(--bf-faint);
}
.bf-textarea-short {
  height: 64px;
  font-family: 'JetBrains Mono', 'SF Mono', Consolas, monospace;
  font-size: 12px;
}
.bf-hint {
  font-size: 11.5px;
  color: var(--bf-faint);
  line-height: 1.55;
  margin: 0 0 12px;
  width: 100%;
  box-sizing: border-box;
}
.bf-toggle {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
  cursor: pointer;
}
.bf-toggle input {
  display: none;
}
.bf-toggle-track {
  width: 34px;
  height: 19px;
  border-radius: 999px;
  background: var(--bf-bg2);
  border: 1px solid var(--bf-border);
  position: relative;
  transition: background 0.18s ease, border-color 0.18s ease;
  flex: none;
}
.bf-toggle input:checked + .bf-toggle-track {
  background: var(--bf-accent);
  border-color: transparent;
}
.bf-toggle-thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 13px;
  height: 13px;
  border-radius: 50%;
  background: var(--bf-text);
  transition: transform 0.18s ease;
}
.bf-toggle input:checked + .bf-toggle-track .bf-toggle-thumb {
  transform: translateX(15px);
  background: #ffffff;
}
.bf-toggle-text {
  font-size: 13px;
  color: var(--bf-text);
}
.bf-toggle-inline {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin: 0 8px;
}
.bf-toggle-inline .bf-toggle-text {
  font-size: 12px;
  white-space: nowrap;
}
.bf-input-shape {
  max-width: 92px;
}
/* 分段控件: 互斥按钮组(排除/只读/无 等) */
.bf-seg {
  display: inline-flex;
  border: 1px solid var(--bf-border);
  border-radius: var(--bf-radius-sm);
  overflow: hidden;
  background: var(--bf-bg2);
}
.bf-seg .bf-btn {
  border: none;
  border-radius: 0;
  background: transparent;
  padding: 6px 14px;
  font-size: 12px;
  color: var(--bf-dim);
}
.bf-seg .bf-btn:hover:not(:disabled) {
  background: var(--bf-hover);
  color: var(--bf-text);
}
.bf-seg .bf-btn.active {
  background: var(--bf-accent-strong);
  color: #ffffff;
}
.bf-seg .bf-btn + .bf-btn {
  border-left: 1px solid var(--bf-border);
}
/* 颜色选择器统一 */
.bf-color-pick {
  width: 30px;
  height: 30px;
  padding: 2px;
  border: 1px solid var(--bf-border);
  border-radius: var(--bf-radius-sm);
  background: var(--bf-bg2);
  cursor: pointer;
  flex: none;
}

/* ---------- Footer ---------- */
.bf-footer {
  position: relative;
  height: 34px;
  flex: none;
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 0 16px;
  font-size: 11.5px;
  color: var(--bf-dim);
  background: var(--bf-bg2);
  border-top: 1px solid var(--bf-border);
}
.bf-footer::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 1px;
  background: linear-gradient(90deg, transparent, var(--bf-accent-soft), var(--bf-accent), var(--bf-accent-soft), transparent);
  opacity: 0.5;
}
.bf-footer-spacer {
  flex: 1;
}

/* ---------- 动画 ---------- */
@keyframes bf-spin {
  to {
    transform: rotate(360deg);
  }
}
.bf-fade-enter-active {
  transition: opacity 0.18s ease;
}
.bf-fade-enter-from {
  opacity: 0;
}
.bf-fade-leave-active,
.bf-fade-leave-to {
  transition: none;
  opacity: 0;
}
.bf-pop-enter-active {
  transition: opacity 0.18s ease;
}
.bf-pop-enter-from {
  opacity: 0;
}
.bf-pop-leave-active,
.bf-pop-leave-to {
  transition: none;
  opacity: 0;
}
.bf-pagefade-enter-active,
.bf-pagefade-leave-active {
  transition: opacity 0.16s ease, transform 0.16s ease;
}
.bf-pagefade-enter-from {
  opacity: 0;
  transform: translateY(4px);
}
.bf-pagefade-leave-to {
  opacity: 0;
}

/* ---------- 滚动条 ---------- */
.bf-main::-webkit-scrollbar,
.bf-npc-list::-webkit-scrollbar,
.bf-npc-detail::-webkit-scrollbar,
.bf-debug-pre::-webkit-scrollbar,
.bf-console::-webkit-scrollbar,
.bf-navbar::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}
.bf-main::-webkit-scrollbar-thumb,
.bf-npc-list::-webkit-scrollbar-thumb,
.bf-npc-detail::-webkit-scrollbar-thumb,
.bf-debug-pre::-webkit-scrollbar-thumb,
.bf-console::-webkit-scrollbar-thumb,
.bf-navbar::-webkit-scrollbar-thumb {
  background: var(--bf-faint);
  border-radius: 4px;
}
.bf-main::-webkit-scrollbar-thumb:hover,
.bf-npc-list::-webkit-scrollbar-thumb:hover,
.bf-npc-detail::-webkit-scrollbar-thumb:hover,
.bf-debug-pre::-webkit-scrollbar-thumb:hover,
.bf-console::-webkit-scrollbar-thumb:hover,
.bf-navbar::-webkit-scrollbar-thumb:hover {
  background: var(--bf-dim);
}

/* ---------- 手机端适配 (<=700px) ---------- */
@media (max-width: 700px) {
  /* 面板全屏 */
  .bf-panel {
    width: 100vw;
    height: 100vh;
    height: 100dvh;
    border-radius: 0;
    border: none;
  }

  /* Header: 第一行品牌+操作, 第二行导航栏等分 */
  .bf-header {
    height: auto;
    flex-wrap: wrap;
    gap: 4px 10px;
    padding: 8px 12px;
  }
  .bf-brand {
    gap: 8px;
  }
  .bf-logo {
    width: 32px;
    height: 32px;
    border-radius: 9px;
  }
  .bf-logo svg {
    width: 20px;
    height: 20px;
  }
  .bf-title {
    font-size: 13px;
  }
  .bf-title-en,
  .bf-subtitle {
    display: none;
  }
  .bf-navbar {
    order: 3;
    flex-basis: 100%;
    justify-content: space-between;
    padding: 2px 0 0;
    overflow-x: hidden;
  }
  .bf-nav {
    flex: 1;
    min-width: 0;
    justify-content: center;
    gap: 4px;
    padding: 7px 2px;
    font-size: 12px;
    border-radius: 6px;
  }
  .bf-nav-icon {
    width: 15px;
    height: 15px;
  }
  .bf-ready,
  .bf-clock,
  .bf-header-right .bf-btn-sm {
    display: none;
  }
  .bf-header-right {
    gap: 4px;
  }

  /* 主内容与页脚 */
  .bf-main {
    padding: 14px 14px 22px;
  }
  .bf-page-title {
    font-size: 16px;
    margin-bottom: 14px;
  }
  .bf-footer {
    height: auto;
    min-height: 30px;
    padding: 5px 12px;
    gap: 8px;
    font-size: 10.5px;
  }
  .bf-footer > span:nth-child(-n + 2) {
    display: none;
  }

  /* 双栏转单列 */
  .bf-dash-layout,
  .bf-logs-layout,
  .bf-settings-layout {
    grid-template-columns: 1fr;
    gap: 10px;
  }
  .bf-dash-side {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 8px;
    position: static;
  }
  .bf-side-card {
    padding: 10px 12px;
  }
  .bf-side-num {
    font-size: 22px;
  }
  .bf-logs-side {
    min-width: 0;
  }

  /* NPC 页: 列表横向滚动在上, 详情在下方整页滚动 */
  .bf-npc-layout {
    flex-direction: column;
    height: auto;
    min-height: 0;
    gap: 10px;
  }
  .bf-npc-list {
    width: 100%;
    flex-direction: row;
    overflow-x: auto;
    padding-right: 0;
    gap: 6px;
  }
  .bf-npc-item {
    flex: none;
    width: 148px;
  }
  .bf-npc-detail {
    flex: none;
    height: auto;
    overflow: visible;
    padding: 14px;
  }
  .bf-detail-fields,
  .bf-field-grid {
    grid-template-columns: 1fr;
    gap: 10px 0;
  }

  /* 输入控件 16px 防 iOS 聚焦自动放大 */
  .bf-input,
  .bf-textarea {
    font-size: 16px;
  }
  .bf-input-num {
    width: 76px;
  }

  /* 卡片与弹窗 */
  .bf-panel-card {
    padding: 12px;
    margin-bottom: 10px;
  }
  .bf-modal {
    width: 92vw;
    max-height: 82vh;
    padding: 14px;
  }
  .bf-debug-pre {
    max-height: 300px;
  }
}


</style>
