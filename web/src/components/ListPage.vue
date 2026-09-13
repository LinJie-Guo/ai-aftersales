<script setup lang="ts">
defineProps<{ title: string; extra?: string }>();
</script>

<template>
  <section class="list-page">
    <header class="list-head">
      <div class="list-heading">
        <h1 class="list-title">{{ title }}</h1>
        <p v-if="extra" class="list-extra">{{ extra }}</p>
      </div>
      <div v-if="$slots.actions" class="list-actions">
        <slot name="actions" />
      </div>
    </header>
    <div v-if="$slots.filters" class="list-filters">
      <slot name="filters" />
    </div>
    <div class="list-table">
      <slot />
    </div>
  </section>
</template>

<style scoped>
.list-page {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  overflow: hidden;
}
.list-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  min-height: 56px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--line);
}
.list-heading { min-width: 0; }
.list-title {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
  line-height: 1.3;
  color: var(--text);
}
.list-extra { margin: 4px 0 0; color: var(--muted); font-size: 12px; }
.list-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.list-filters {
  padding: 12px 16px;
  background: var(--surface-2);
  border-bottom: 1px solid var(--line);
}
.list-filters :deep(.ant-form-inline) { row-gap: 8px; }
.list-filters :deep(.ant-form-item) { margin-bottom: 0; }
.list-table { padding: 8px 0 0; }
.list-table :deep(.ant-table-wrapper) { padding: 0 16px 4px; }
.list-table :deep(.ant-table) { background: transparent; }
.list-table :deep(.ant-table-thead > tr > th) {
  background: var(--surface-2);
  color: var(--muted);
  font-weight: 600;
  white-space: nowrap;
  border-bottom-color: var(--line);
}
.list-table :deep(.ant-table-tbody > tr > td) {
  border-bottom-color: var(--line);
  white-space: nowrap;
  vertical-align: middle;
}
.list-table :deep(.ant-table-cell-ellipsis) { max-width: 280px; }
.list-table :deep(.ant-pagination) { margin: 12px 16px 16px; }
.list-table :deep(.acts) { display: inline-flex; align-items: center; gap: 12px; white-space: nowrap; }
.list-table :deep(.acts a) { color: var(--blue); cursor: pointer; }
.list-table :deep(.acts a.danger) { color: var(--red); }
.list-table :deep(.acts a.disabled),
.list-table :deep(.acts .is-off) { color: var(--muted); cursor: not-allowed; }
</style>
