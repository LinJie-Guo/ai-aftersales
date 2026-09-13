<script setup lang="ts">
import { computed } from "vue";
import { ChevronLeft, ChevronRight } from "lucide-vue-next";

const props = defineProps<{
  total: number;
  page: number;
  pageSize: number;
}>();

const emit = defineEmits<{
  "update:page": [number];
  "update:pageSize": [number];
}>();

const totalPages = computed(() => Math.max(1, Math.ceil(props.total / props.pageSize)));

const pageNums = computed(() => {
  const tp = totalPages.value;
  const cur = props.page;
  const windowSize = 5;
  let start = Math.max(1, cur - Math.floor(windowSize / 2));
  let end = Math.min(tp, start + windowSize - 1);
  start = Math.max(1, end - windowSize + 1);
  const nums: number[] = [];
  for (let i = start; i <= end; i++) nums.push(i);
  return nums;
});

function setPage(p: number) {
  if (p >= 1 && p <= totalPages.value) emit("update:page", p);
}
</script>

<template>
  <div v-if="total > 0" class="pagination">
    <span>共 {{ total }} 条</span>
    <div class="page-controls">
      <button type="button" class="page-btn" :disabled="page <= 1" @click="setPage(page - 1)">
        <ChevronLeft :size="16" />
      </button>
      <button
        v-for="n in pageNums"
        :key="n"
        type="button"
        class="page-btn"
        :class="{ active: n === page }"
        @click="setPage(n)"
      >
        {{ n }}
      </button>
      <button type="button" class="page-btn" :disabled="page >= totalPages" @click="setPage(page + 1)">
        <ChevronRight :size="16" />
      </button>
      <select
        class="page-size"
        :value="pageSize"
        @change="emit('update:pageSize', Number(($event.target as HTMLSelectElement).value))"
      >
        <option :value="10">10 条/页</option>
        <option :value="20">20 条/页</option>
        <option :value="50">50 条/页</option>
      </select>
    </div>
  </div>
</template>
