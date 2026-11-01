import { type ReactNode } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  type TextInputProps,
  ToastAndroid,
  View,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { type PillColors, avatarColor, colors } from './theme';

export function toast(message: string): void {
  if (Platform.OS === 'android') ToastAndroid.show(message, ToastAndroid.LONG);
  else Alert.alert('', message);
}

export function confirm(title: string, message: string, action: string, onYes: () => void): void {
  Alert.alert(title, message, [
    { text: 'Huỷ', style: 'cancel' },
    { text: action, onPress: onYes },
  ]);
}

/** Danh sách lựa chọn một: Alert trên điện thoại không đủ chỗ cho nhiều mục nên dùng nút lần lượt. */
export function choose(title: string, labels: readonly string[], onPick: (i: number) => void): void {
  Alert.alert(title, undefined, [
    ...labels.map((text, i) => ({ text, onPress: () => onPick(i) })),
    { text: 'Huỷ', style: 'cancel' as const },
  ]);
}

export function Screen({ children, scroll = true, padded = true }: { children: ReactNode; scroll?: boolean; padded?: boolean }) {
  const body = scroll ? (
    <ScrollView contentContainerStyle={[padded && styles.pad, { paddingBottom: 40 }]} keyboardShouldPersistTaps="handled">
      {children}
    </ScrollView>
  ) : (
    <View style={[{ flex: 1 }, padded && styles.pad]}>{children}</View>
  );
  return (
    <SafeAreaView style={styles.screen} edges={['left', 'right', 'bottom']}>
      {body}
    </SafeAreaView>
  );
}

export function Loading() {
  return (
    <View style={[styles.screen, { alignItems: 'center', justifyContent: 'center' }]}>
      <ActivityIndicator color={colors.brand} size="large" />
    </View>
  );
}

/** Thanh báo đồng bộ nằm đè phía dưới màn hình: lỗi kết nối hoặc mạng chậm, kèm nút thử lại. */
export function SyncBanner({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <SafeAreaView edges={['bottom']} style={styles.banner} pointerEvents="box-none">
      <View style={styles.bannerBody}>
        <Text style={{ color: colors.warnFg, flex: 1, fontSize: 14 }}>{message}</Text>
        <Button title="Thử lại" kind="text" onPress={onRetry} />
      </View>
    </SafeAreaView>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Label({ children }: { children: ReactNode }) {
  return <Text style={styles.label}>{children}</Text>;
}

export function Muted({ children, style }: { children: ReactNode; style?: object }) {
  return <Text style={[{ color: colors.muted, fontSize: 13 }, style]}>{children}</Text>;
}

export function Button({
  title,
  onPress,
  kind = 'primary',
  disabled,
  style,
}: {
  title: string;
  onPress: () => void;
  kind?: 'primary' | 'outline' | 'danger' | 'text';
  disabled?: boolean;
  style?: ViewStyle;
}) {
  const bg = kind === 'primary' ? colors.brand : kind === 'danger' ? colors.owe : 'transparent';
  const fg = kind === 'primary' || kind === 'danger' ? '#fff' : kind === 'text' ? colors.brand : colors.brand;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.btn,
        { backgroundColor: bg, opacity: disabled ? 0.45 : pressed ? 0.8 : 1 },
        kind === 'outline' && { borderWidth: 1, borderColor: colors.brand },
        kind === 'text' && { paddingVertical: 8 },
        style,
      ]}
    >
      <Text style={{ color: fg, fontWeight: '600', fontSize: 15 }}>{title}</Text>
    </Pressable>
  );
}

export function Avatar({ name, colorIndex, size = 40 }: { name: string; colorIndex: number; size?: number }) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: avatarColor(colorIndex),
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Text style={{ color: '#fff', fontWeight: '700', fontSize: size * 0.42 }}>
        {name ? name.substring(0, 1).toUpperCase() : '?'}
      </Text>
    </View>
  );
}

export function Pill({ text, colors: c }: { text: string; colors: PillColors }) {
  return (
    <View style={{ backgroundColor: c.bg, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3, alignSelf: 'flex-start' }}>
      <Text style={{ color: c.fg, fontSize: 12, fontWeight: '600' }}>{text}</Text>
    </View>
  );
}

export interface RowData {
  key: string;
  avatarName?: string;
  colorIndex?: number;
  title: string;
  subtitle?: string;
  multiline?: boolean;
  amount?: string;
  amountColor?: string;
  pill?: string;
  pillColors?: PillColors;
  onPress?: () => void;
}

/** Một thẻ dòng dùng cho mọi danh sách: avatar, tiêu đề, dòng phụ, số tiền, nhãn. */
export function Row({ r }: { r: RowData }) {
  const content = (
    <View style={styles.row}>
      {r.avatarName != null && <Avatar name={r.avatarName} colorIndex={r.colorIndex ?? 0} />}
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: colors.ink, fontSize: 15, fontWeight: '600' }}>{r.title}</Text>
        {r.subtitle != null && (
          <Text numberOfLines={r.multiline ? 6 : 2} style={{ color: colors.muted, fontSize: 13 }}>
            {r.subtitle}
          </Text>
        )}
        {r.pill != null && r.pillColors != null && (
          <View style={{ marginTop: 4 }}>
            <Pill text={r.pill} colors={r.pillColors} />
          </View>
        )}
      </View>
      {r.amount != null && <Text style={{ color: r.amountColor ?? colors.ink, fontWeight: '700', fontSize: 15 }}>{r.amount}</Text>}
    </View>
  );
  return r.onPress ? (
    <Pressable onPress={r.onPress} style={({ pressed }) => [styles.card, { opacity: pressed ? 0.7 : 1 }]}>
      {content}
    </Pressable>
  ) : (
    <View style={styles.card}>{content}</View>
  );
}

export function Rows({ rows, empty }: { rows: RowData[]; empty?: string }) {
  if (rows.length === 0) return empty ? <Muted style={{ paddingVertical: 8 }}>{empty}</Muted> : null;
  return (
    <View style={{ gap: 8 }}>
      {rows.map((r) => (
        <Row key={r.key} r={r} />
      ))}
    </View>
  );
}

export function Chip({
  text,
  selected,
  onPress,
  onClose,
}: {
  text: string;
  selected?: boolean;
  onPress?: () => void;
  onClose?: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: selected ? colors.brand : colors.line,
        backgroundColor: selected ? colors.okBg : colors.surface,
        paddingHorizontal: 12,
        paddingVertical: 7,
      }}
    >
      <Text style={{ color: selected ? colors.okFg : colors.ink, fontSize: 13 }}>{text}</Text>
      {onClose && (
        <Pressable onPress={onClose} hitSlop={8}>
          <Text style={{ color: colors.muted, fontSize: 14 }}>✕</Text>
        </Pressable>
      )}
    </Pressable>
  );
}

export function ChipRow({ children }: { children: ReactNode }) {
  return <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{children}</View>;
}

export function Field({
  label,
  error,
  ...props
}: TextInputProps & { label?: string; error?: string | null }) {
  return (
    <View style={{ gap: 4 }}>
      {label != null && <Text style={{ color: colors.muted, fontSize: 12 }}>{label}</Text>}
      <TextInput
        placeholderTextColor="#9a958b"
        {...props}
        style={[styles.input, error ? { borderColor: colors.owe } : null, props.style]}
      />
      {error ? <Text style={{ color: colors.owe, fontSize: 12 }}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  // Chừa chỗ cho thanh tab ở dưới.
  banner: { position: 'absolute', left: 0, right: 0, bottom: 56 },
  bannerBody: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    margin: 12,
    paddingLeft: 16,
    paddingRight: 4,
    borderRadius: 12,
    backgroundColor: colors.warnBg,
    borderWidth: 1,
    borderColor: colors.lineStrong,
  },
  screen: { flex: 1, backgroundColor: colors.paper },
  pad: { padding: 16, gap: 12 },
  card: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.line,
    padding: 12,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  label: { color: colors.muted, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.6, marginTop: 8 },
  btn: { borderRadius: 10, paddingVertical: 13, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' },
  input: {
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: colors.surface,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: colors.ink,
  },
});
