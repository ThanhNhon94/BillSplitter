import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState as RNAppState } from 'react-native';
import type { AppSnapshot } from '@/data/AppSnapshot';
import { authRepository, ledgerRepository } from '@/data/firebase';
import type { AuthRepository } from '@/data/AuthRepository';
import type { LedgerRepository } from '@/data/LedgerRepository';
import { RECONNECT_AFTER_BACKGROUND_MS, SLOW_AFTER_MS, retryDelay, syncErrorMessage } from './sync';

interface AppState {
  /** false cho tới khi Firebase khôi phục xong phiên đăng nhập. */
  authReady: boolean;
  /** Tài khoản đang dùng; null nếu chưa đăng nhập. */
  userId: string | null;
  /** null cho tới khi mọi nguồn dữ liệu trả kết quả đầu tiên. */
  snapshot: AppSnapshot | null;
  /** Câu báo lỗi đồng bộ gần nhất; app vẫn tự thử lại trong lúc hiện câu này. */
  syncError: string | null;
  /** true khi đã chờ lâu (SLOW_AFTER_MS) mà vẫn chưa có dữ liệu. */
  slow: boolean;
  /** Huỷ các listener và đăng ký lại ngay. */
  retry: () => void;
  repo: LedgerRepository;
  auth: AuthRepository;
}

const Ctx = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [authReady, setAuthReady] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [slow, setSlow] = useState(false);
  // Mỗi lần tăng là một lần huỷ watchSnapshot và đăng ký lại.
  const [attempt, setAttempt] = useState(0);
  const failures = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const resubscribe = useCallback(() => {
    if (retryTimer.current) clearTimeout(retryTimer.current);
    retryTimer.current = null;
    setAttempt((a) => a + 1);
  }, []);

  // Bấm "Thử lại": nối lại mạng ngay (SDK có thể đang chờ tới cả phút giữa hai lần thử) và đăng ký lại.
  const retry = useCallback(() => {
    ledgerRepository.reconnect().catch(() => undefined);
    resubscribe();
  }, [resubscribe]);

  useEffect(
    () =>
      authRepository.onAuthStateChanged((id) => {
        setUserId(id);
        setSnapshot(null);
        setSyncError(null);
        failures.current = 0;
        setAuthReady(true);
      }),
    [],
  );

  // Listener gặp lỗi là dừng hẳn, nên lỗi nào cũng dẫn tới đăng ký lại cả bộ, chờ tăng dần.
  // Snapshot cũ được giữ trong lúc chờ, để màn hình không quay về vòng tải.
  useEffect(() => {
    if (!userId) return;
    let failed = false;
    const unsub = ledgerRepository.subscribe(
      userId,
      (s) => {
        failures.current = 0;
        setSyncError(null);
        setSnapshot(s);
      },
      (e) => {
        if (__DEV__) console.warn('[sync]', (e as { code?: string }).code, e.message);
        setSyncError(syncErrorMessage(e));
        if (failed) return;
        failed = true;
        failures.current += 1;
        retryTimer.current = setTimeout(resubscribe, retryDelay(failures.current));
      },
    );
    return () => {
      unsub();
      if (retryTimer.current) clearTimeout(retryTimer.current);
      retryTimer.current = null;
    };
  }, [userId, attempt, resubscribe]);

  // Trở lại app sau một lúc ở nền: kết nối cũ thường đã chết và SDK đang chờ giữa hai lần thử, nên nối lại ngay.
  useEffect(() => {
    let leftAt = 0;
    const sub = RNAppState.addEventListener('change', (state) => {
      if (state !== 'active') {
        if (leftAt === 0) leftAt = Date.now();
        return;
      }
      const away = leftAt === 0 ? 0 : Date.now() - leftAt;
      leftAt = 0;
      if (retryTimer.current) retry();
      else if (away >= RECONNECT_AFTER_BACKGROUND_MS) ledgerRepository.reconnect().catch(() => undefined);
    });
    return () => sub.remove();
  }, [retry]);

  const waiting = userId != null && snapshot == null;
  useEffect(() => {
    setSlow(false);
    if (!waiting) return;
    const t = setTimeout(() => setSlow(true), SLOW_AFTER_MS);
    return () => clearTimeout(t);
  }, [waiting, attempt]);

  const value = useMemo<AppState>(
    () => ({ authReady, userId, snapshot, syncError, slow, retry, repo: ledgerRepository, auth: authRepository }),
    [authReady, userId, snapshot, syncError, slow, retry],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp ngoài AppProvider');
  return v;
}

/** Màn đã đăng nhập: userId và snapshot chắc chắn có (null trong lúc đang tải). */
export function useLedger(): { userId: string; snapshot: AppSnapshot; repo: LedgerRepository } | null {
  const { userId, snapshot, repo } = useApp();
  if (!userId || !snapshot) return null;
  return { userId, snapshot, repo };
}

/** Chạy một thao tác ghi, hiện lỗi nghiệp vụ bằng toast. Trả true nếu thành công. */
export function useAction() {
  return useCallback(async (fn: () => Promise<unknown>, onError?: (message: string) => void): Promise<boolean> => {
    try {
      await fn();
      return true;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (onError) onError(message);
      else (await import('@/ui/components')).toast(message);
      return false;
    }
  }, []);
}
