import { useCallback, useState } from "react";
import { loadSort, nextSort, saveSort, type SortDir, type SortState } from "@/lib/tableSort";

/** 一张表的排序状态：点表头切换，记在本机（storageKey 每张表一个） */
export function useTableSort(storageKey: string, keys: readonly string[]) {
  const [sort, setSort] = useState<SortState | null>(() => loadSort(storageKey, keys));
  const set = useCallback((next: SortState | null) => { setSort(next); saveSort(storageKey, next); }, [storageKey]);
  const onSort = useCallback((key: string, firstDir: SortDir = "desc") => {
    setSort((cur) => {
      const next = nextSort(cur, key, firstDir);
      saveSort(storageKey, next);
      return next;
    });
  }, [storageKey]);
  return { sort, onSort, setSort: set };
}
