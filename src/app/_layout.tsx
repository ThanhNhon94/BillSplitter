import { Stack, router } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { LogBox, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AppProvider, useApp } from "@/state/AppContext";
import {
  onNotificationTap,
  setupNotifications,
  useInboxNotifications,
} from "@/state/notifications";
import { Loading, SyncBanner } from "@/ui/components";
import { colors } from "@/ui/theme";

// Mất mạng là chuyện thường trên điện thoại: SDK tự thử lại và SyncBanner đã báo cho người dùng,
// nên không bật màn đỏ LogBox (log vẫn in ra terminal Metro).
LogBox.ignoreLogs(["Could not reach Cloud Firestore backend"]);

function Gate() {
  const { authReady, userId, snapshot, syncError, slow, retry } = useApp();
  useInboxNotifications(userId, snapshot);

  useEffect(() => {
    setupNotifications().catch(() => undefined);
    // Bấm thông báo: mở đúng khoản nợ / hoá đơn.
    return onNotificationTap((d) => {
      if (d.debtKey)
        router.push({ pathname: "/debt/[key]", params: { key: d.debtKey } });
      else if (d.billId)
        router.push({ pathname: "/bill/[id]", params: { id: d.billId } });
    });
  }, []);

  if (!authReady) return <Loading />;
  const banner =
    userId == null
      ? null
      : (syncError ??
        (slow && !snapshot
          ? "Mạng chậm, đang tải dữ liệu lâu hơn bình thường…"
          : null));
  return (
    <View style={{ flex: 1 }}>
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.brand },
          headerTintColor: "#fff",
          headerTitleStyle: { fontWeight: "700" },
          contentStyle: { backgroundColor: colors.paper },
        }}
      >
        <Stack.Protected guard={!userId}>
          <Stack.Screen name="login" options={{ headerShown: false }} />
        </Stack.Protected>
        <Stack.Protected guard={!!userId}>
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="create-group" options={{ title: "Nhóm mới" }} />
          <Stack.Screen name="group/[id]" options={{ title: "Nhóm" }} />
          <Stack.Screen name="group/settle" options={{ title: "Tất toán" }} />
          <Stack.Screen name="bill/[id]" options={{ title: "Hoá đơn" }} />
          <Stack.Screen name="bill/edit" options={{ title: "Hoá đơn" }} />
          <Stack.Screen name="debt/[key]" options={{ title: "Khoản nợ" }} />
          <Stack.Screen name="qr-setup" options={{ title: "QR nhận tiền" }} />
        </Stack.Protected>
      </Stack>
      {banner && <SyncBanner message={banner} onRetry={retry} />}
    </View>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <AppProvider>
        <StatusBar style="light" />
        <Gate />
      </AppProvider>
    </SafeAreaProvider>
  );
}
