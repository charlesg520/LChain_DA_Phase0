import { holdFrames, releaseFrames, useStore } from "../store";
import type { HistoryDetail, HistoryRun } from "../types";
import { api } from "./api";

export async function refreshHistory() {
  const { setHistory } = useStore.getState();
  setHistory({ loading: true, error: undefined });
  try {
    const data = await api<{ runs: HistoryRun[] }>("/history");
    setHistory({ runs: data.runs, loading: false, loaded: true });
  } catch (e) {
    setHistory({ loading: false, loaded: true, error: (e as Error).message });
  }
}

export async function openHistory(id: string) {
  const st = useStore.getState();
  holdFrames(id);
  try {
    const d = await api<HistoryDetail>(`/history/${encodeURIComponent(id)}`);
    st.loadHistoryDetail(d);
    releaseFrames(true);
  } catch (e) {
    releaseFrames(false);
    st.toast("error", `Could not open that chat: ${(e as Error).message}`);
  }
}

export async function deleteHistory(id: string) {
  const st = useStore.getState();
  try {
    await api(`/history/${encodeURIComponent(id)}`, { method: "DELETE" });
    st.setHistory({ runs: st.history.runs.filter((r) => r.id !== id) });
    if (st.run.id === id) st.newChat();
  } catch (e) {
    st.toast("error", `Delete failed: ${(e as Error).message}`);
  }
}
