<script setup lang="ts">
import { PhCheck, PhX } from '@phosphor-icons/vue';
import { onMounted, ref } from 'vue';

defineProps<{
  draft: { layer: string; key: string; fields: Record<string, string> };
  defs: { key: string; label: string; enum?: readonly string[]; multiline?: boolean }[];
}>();
defineEmits<{ save: []; cancel: [] }>();

const el = ref<HTMLElement | null>(null);
onMounted(() => el.value?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
</script>

<template>
  <div ref="el" class="yh-world-edit">
    <div class="yh-world-edit-head">
      <strong>{{ draft.key ? '编辑' : '新增' }}{{ draft.layer }}</strong>
      <button class="yh-icon-btn" @click="$emit('cancel')">
        <PhX :size="13" weight="regular" />
      </button>
    </div>
    <label v-for="f in defs" :key="f.key" class="yh-field">
      <span class="yh-field-label">{{ f.label }}</span>
      <select v-if="f.enum" v-model="draft.fields[f.key]" class="yh-input yh-select">
        <option v-for="o in f.enum || []" :key="o" :value="o">{{ o }}</option>
      </select>
      <textarea v-else-if="f.multiline" v-model="draft.fields[f.key]" class="yh-input yh-textarea" rows="2"></textarea>
      <input v-else v-model="draft.fields[f.key]" type="text" class="yh-input" />
    </label>
    <div class="yh-edit-actions">
      <button class="yh-btn yh-btn-primary yh-btn-sm" @click="$emit('save')">
        <PhCheck :size="12" weight="bold" />保存
      </button>
      <button class="yh-btn yh-btn-sm" @click="$emit('cancel')">取消</button>
    </div>
  </div>
</template>
