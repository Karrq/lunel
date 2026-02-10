import { useTheme } from "@/contexts/ThemeContext";
import { LogOut } from "lucide-react-native";
import { StatusBar } from "expo-status-bar";
import {
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

export default function TempPage() {
  const { colors, isDark, radius } = useTheme();

  return (
    <View style={[styles.container, { backgroundColor: colors.bg.base }]}>
      <StatusBar style={isDark ? "light" : "dark"} />

      <ScrollView contentContainerStyle={styles.scrollContent}>
        <View style={styles.header}>
          <View style={[styles.logoCircle, { borderRadius: radius.xl }]}>
            <Image
              source={require("../../assets/images/logo/logo-light.jpg")}
              style={styles.logoImage}
              resizeMode="cover"
            />
          </View>
          <Text style={[styles.title, { color: colors.fg.default }]}>
            Welcome to Lunel!
          </Text>
          <Text style={[styles.subtitle, { color: colors.fg.muted }]}>
            You&apos;ve successfully logged in!
          </Text>
        </View>

        <View style={styles.content}>
          <View style={styles.buttonsContainer}>
            <Pressable
              onPress={() => {}}
              style={[
                styles.button,
                {
                  borderColor: colors.status.error,
                  backgroundColor: colors.status.errorSubtle,
                  borderRadius: radius.lg,
                },
              ]}
            >
              <LogOut size={20} color={colors.status.error} strokeWidth={2} />
              <Text style={[styles.buttonText, { color: colors.status.error }]}>
                Logout
              </Text>
            </Pressable>
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    paddingVertical: 40,
    paddingHorizontal: 24,
  },
  header: {
    alignItems: "center",
    marginBottom: 32,
  },
  logoCircle: {
    width: 80,
    height: 80,
    overflow: "hidden",
    marginBottom: 16,
  },
  logoImage: {
    width: "100%",
    height: "100%",
  },
  title: {
    fontSize: 28,
    fontWeight: "700",
    marginBottom: 8,
    textAlign: "center",
  },
  subtitle: {
    fontSize: 14,
    textAlign: "center",
    paddingHorizontal: 32,
  },
  content: {
    flex: 1,
  },
  buttonsContainer: {
    gap: 16,
    marginBottom: 24,
  },
  button: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    paddingVertical: 16,
    paddingHorizontal: 24,
    borderWidth: 1,
  },
  buttonText: {
    fontSize: 16,
    fontWeight: "600",
  },
});
