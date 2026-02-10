import { ConnectionProvider } from "@/contexts/ConnectionContext";
import { EditorProvider } from "@/contexts/EditorContext";
import { ThemeProvider, useTheme } from "@/contexts/ThemeContext";
import { PluginProvider } from "@/plugins";
import "@/plugins/load"; // Load all plugins
// Sans fonts
import {
  DMSans_400Regular,
  DMSans_500Medium,
  DMSans_600SemiBold,
  DMSans_700Bold,
} from "@expo-google-fonts/dm-sans";
import {
  IBMPlexSans_400Regular,
  IBMPlexSans_500Medium,
  IBMPlexSans_600SemiBold,
  IBMPlexSans_700Bold,
} from "@expo-google-fonts/ibm-plex-sans";
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
} from "@expo-google-fonts/inter";
import {
  Roboto_400Regular,
  Roboto_500Medium,
  Roboto_700Bold,
} from "@expo-google-fonts/roboto";
import {
  SourceSans3_400Regular,
  SourceSans3_500Medium,
  SourceSans3_600SemiBold,
  SourceSans3_700Bold,
} from "@expo-google-fonts/source-sans-3";
// Mono fonts
import {
  DMMono_400Regular,
  DMMono_500Medium,
} from "@expo-google-fonts/dm-mono";
import {
  FiraCode_400Regular,
  FiraCode_500Medium,
  FiraCode_700Bold,
} from "@expo-google-fonts/fira-code";
import {
  IBMPlexMono_400Regular,
  IBMPlexMono_500Medium,
  IBMPlexMono_700Bold,
} from "@expo-google-fonts/ibm-plex-mono";
import {
  JetBrainsMono_400Regular,
  JetBrainsMono_500Medium,
  JetBrainsMono_700Bold,
} from "@expo-google-fonts/jetbrains-mono";
import {
  SourceCodePro_400Regular,
  SourceCodePro_500Medium,
  SourceCodePro_700Bold,
} from "@expo-google-fonts/source-code-pro";
// Serif fonts
import {
  IBMPlexSerif_400Regular,
  IBMPlexSerif_500Medium,
  IBMPlexSerif_600SemiBold,
  IBMPlexSerif_700Bold,
} from "@expo-google-fonts/ibm-plex-serif";
import {
  Lora_400Regular,
  Lora_500Medium,
  Lora_600SemiBold,
  Lora_700Bold,
} from "@expo-google-fonts/lora";
import {
  Merriweather_400Regular,
  Merriweather_700Bold,
  Merriweather_900Black,
} from "@expo-google-fonts/merriweather";
import {
  PlayfairDisplay_400Regular,
  PlayfairDisplay_500Medium,
  PlayfairDisplay_600SemiBold,
  PlayfairDisplay_700Bold,
} from "@expo-google-fonts/playfair-display";
import {
  SourceSerif4_400Regular,
  SourceSerif4_500Medium,
  SourceSerif4_600SemiBold,
  SourceSerif4_700Bold,
} from "@expo-google-fonts/source-serif-4";
// Display fonts
import { Khand_600SemiBold, useFonts } from "@expo-google-fonts/khand";
import { Orbitron_700Bold } from "@expo-google-fonts/orbitron";
import { SpaceGrotesk_700Bold } from "@expo-google-fonts/space-grotesk";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";

SplashScreen.preventAutoHideAsync();

function RootLayoutContent() {
  const { colors, isDark } = useTheme();
  const [isReady, setIsReady] = useState(false);
  const [fontsLoaded] = useFonts({
    // Sans fonts
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
    Roboto_400Regular,
    Roboto_500Medium,
    Roboto_700Bold,
    IBMPlexSans_400Regular,
    IBMPlexSans_500Medium,
    IBMPlexSans_600SemiBold,
    IBMPlexSans_700Bold,
    SourceSans3_400Regular,
    SourceSans3_500Medium,
    SourceSans3_600SemiBold,
    SourceSans3_700Bold,
    DMSans_400Regular,
    DMSans_500Medium,
    DMSans_600SemiBold,
    DMSans_700Bold,
    // Mono fonts
    JetBrainsMono_400Regular,
    JetBrainsMono_500Medium,
    JetBrainsMono_700Bold,
    FiraCode_400Regular,
    FiraCode_500Medium,
    FiraCode_700Bold,
    SourceCodePro_400Regular,
    SourceCodePro_500Medium,
    SourceCodePro_700Bold,
    IBMPlexMono_400Regular,
    IBMPlexMono_500Medium,
    IBMPlexMono_700Bold,
    DMMono_400Regular,
    DMMono_500Medium,
    // Serif fonts
    Merriweather_400Regular,
    Merriweather_700Bold,
    Merriweather_900Black,
    Lora_400Regular,
    Lora_500Medium,
    Lora_600SemiBold,
    Lora_700Bold,
    PlayfairDisplay_400Regular,
    PlayfairDisplay_500Medium,
    PlayfairDisplay_600SemiBold,
    PlayfairDisplay_700Bold,
    IBMPlexSerif_400Regular,
    IBMPlexSerif_500Medium,
    IBMPlexSerif_600SemiBold,
    IBMPlexSerif_700Bold,
    SourceSerif4_400Regular,
    SourceSerif4_500Medium,
    SourceSerif4_600SemiBold,
    SourceSerif4_700Bold,
    // Display fonts
    Khand_600SemiBold,
    Orbitron_700Bold,
    SpaceGrotesk_700Bold,
  });

  useEffect(() => {
    // Proxy servers start dynamically when CLI reports open ports
    setIsReady(true);
  }, []);

  useEffect(() => {
    if (isReady && fontsLoaded) {
      SplashScreen.hide();
    }
  }, [isReady, fontsLoaded]);

  if (!isReady || !fontsLoaded) {
    return null;
  }

  return (
    <SafeAreaProvider>
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg.raised }}>
        <StatusBar style={isDark ? "light" : "dark"} />
        <Stack
          screenOptions={{
            animation: "none",
            headerShown: false,
            contentStyle: { backgroundColor: colors.bg.base },
          }}
        />
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

export default function RootLayout() {
  return (
    <ConnectionProvider>
      <ThemeProvider>
        <EditorProvider>
          <PluginProvider>
            <RootLayoutContent />
          </PluginProvider>
        </EditorProvider>
      </ThemeProvider>
    </ConnectionProvider>
  );
}
