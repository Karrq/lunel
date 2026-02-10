import { useTheme } from "@/contexts/ThemeContext";
import { Github, Link2 } from "lucide-react-native";
import { useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import {
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

export default function Auth() {
  const { colors, fonts, radius, isDark } = useTheme();
  const router = useRouter();

  const handleLunelLink = () => {
    router.push("/lunel-link");
  };

  const handleGoToEditor = () => {
    router.replace("/workspace");
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.bg.base }]}>
      <StatusBar style={isDark ? 'light' : 'dark'} />

      <View style={styles.content}>
        <Text style={[styles.title, { color: colors.fg.default, fontFamily: fonts.sans.bold }]}>
          Lunel
        </Text>

        <View style={styles.buttonsContainer}>
          <TouchableOpacity
            onPress={() => {}}
            activeOpacity={0.8}
            style={[
              styles.button,
              {
                backgroundColor: colors.fg.default,
                borderRadius: radius.md,
              },
            ]}
          >
            <Github size={18} color={colors.bg.base} strokeWidth={2} />
            <Text style={[styles.buttonText, { color: colors.bg.base, fontFamily: fonts.sans.medium }]}>
              Sign in with GitHub
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            onPress={handleLunelLink}
            activeOpacity={0.8}
            style={[
              styles.button,
              {
                backgroundColor: colors.bg.raised,
                borderRadius: radius.md,
              },
            ]}
          >
            <Link2 size={18} color={colors.fg.default} strokeWidth={2} />
            <Text style={[styles.buttonText, { color: colors.fg.default, fontFamily: fonts.sans.medium }]}>
              Lunel Link
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      <View style={styles.bottomLinks}>
        <TouchableOpacity onPress={() => {}}>
          <Text style={[styles.linkText, { color: colors.accent.default, fontFamily: fonts.sans.regular }]}>
            Having trouble signing in?
          </Text>
        </TouchableOpacity>
        <Text style={[styles.linkDivider, { color: colors.fg.muted }]}>·</Text>
        <TouchableOpacity onPress={handleGoToEditor}>
          <Text style={[styles.linkText, { color: colors.accent.default, fontFamily: fonts.sans.regular }]}>
            Go to Editor
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  title: {
    fontSize: 42,
    marginBottom: 48,
  },
  buttonsContainer: {
    width: "100%",
    gap: 12,
  },
  button: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    paddingHorizontal: 24,
    paddingVertical: 14,
  },
  buttonText: {
    fontSize: 15,
  },
  bottomLinks: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingBottom: 24,
    gap: 8,
  },
  linkText: {
    fontSize: 12,
  },
  linkDivider: {
    fontSize: 12,
  },
});
