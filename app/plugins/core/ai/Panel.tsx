import PluginHeader, { BaseTab } from "@/components/PluginHeader";
import { useTheme } from "@/contexts/ThemeContext";
import { useConnection } from "@/contexts/ConnectionContext";
import { useAI } from "@/hooks/useAI";
import type { AIEvent, AISession, AIMessage, AIPart, AIAgent, AIProvider, AIPermission, ModelRef } from "./types";
import {
  Sparkles, ChevronUp, ChevronDown, Check, X, Plus, Image as ImageIcon,
  ArrowUp, Hammer, Map, Square, Undo2, Redo2, Share2, AlertTriangle, Key, MoreHorizontal,
} from "lucide-react-native";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Keyboard,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { PluginPanelProps } from "../../types";

// Session tab interface
interface AITab extends BaseTab {
  sessionId?: string;
}

// ============================================================================
// Message Parts Renderer
// ============================================================================

function TextPartView({ part, colors, fonts }: { part: AIPart; colors: any; fonts: any }) {
  return (
    <Text style={{ color: colors.fg.default, fontSize: 13, fontFamily: fonts.mono.regular, lineHeight: 20 }}>
      {part.text as string || ""}
    </Text>
  );
}

function ToolPartView({ part, colors, fonts, radius }: { part: AIPart; colors: any; fonts: any; radius: any }) {
  const [expanded, setExpanded] = useState(false);
  const toolName = (part.name as string) || (part.toolName as string) || "tool";
  const state = (part.state as string) || "running";

  return (
    <View style={{
      backgroundColor: colors.bg.raised,
      borderRadius: radius.sm,
      borderWidth: 1,
      borderColor: colors.bg.overlay,
      marginVertical: 4,
      overflow: "hidden",
    }}>
      <TouchableOpacity
        onPress={() => setExpanded(!expanded)}
        style={{ flexDirection: "row", alignItems: "center", padding: 10, gap: 8 }}
        activeOpacity={0.7}
      >
        {state === "running" ? (
          <ActivityIndicator size="small" color={colors.accent.default} />
        ) : (
          <Check size={14} color={colors.fg.muted} strokeWidth={2} />
        )}
        <Text style={{ color: colors.fg.default, fontSize: 12, fontFamily: fonts.mono.regular, flex: 1 }}>
          {toolName}
        </Text>
        {expanded ? (
          <ChevronUp size={12} color={colors.fg.muted} strokeWidth={2} />
        ) : (
          <ChevronDown size={12} color={colors.fg.muted} strokeWidth={2} />
        )}
      </TouchableOpacity>
      {expanded && (
        <View style={{ padding: 10, borderTopWidth: 1, borderTopColor: colors.bg.overlay }}>
          {part.input && (
            <Text style={{ color: colors.fg.muted, fontSize: 11, fontFamily: fonts.mono.regular, marginBottom: 6 }}>
              {typeof part.input === "string" ? part.input : JSON.stringify(part.input, null, 2)}
            </Text>
          )}
          {part.output && (
            <Text style={{ color: colors.fg.subtle, fontSize: 11, fontFamily: fonts.mono.regular }}>
              {typeof part.output === "string" ? part.output : JSON.stringify(part.output, null, 2)}
            </Text>
          )}
        </View>
      )}
    </View>
  );
}

function StepPartView({ part, colors, fonts }: { part: AIPart; colors: any; fonts: any }) {
  const isStart = part.type === "step-start";
  return (
    <Text style={{ color: colors.fg.muted, fontSize: 11, fontFamily: fonts.mono.regular, fontStyle: "italic", marginVertical: 2 }}>
      {isStart ? `${part.title || "Working"}...` : `Done: ${part.title || ""}`}
    </Text>
  );
}

function MessagePartView({ part, colors, fonts, radius }: { part: AIPart; colors: any; fonts: any; radius: any }) {
  switch (part.type) {
    case "text":
      return <TextPartView part={part} colors={colors} fonts={fonts} />;
    case "tool":
    case "tool-call":
    case "tool-result":
      return <ToolPartView part={part} colors={colors} fonts={fonts} radius={radius} />;
    case "step-start":
    case "step-finish":
      return <StepPartView part={part} colors={colors} fonts={fonts} />;
    default:
      return null;
  }
}

// ============================================================================
// Message Bubble
// ============================================================================

function MessageBubble({ message, colors, fonts, radius }: {
  message: AIMessage; colors: any; fonts: any; radius: any;
}) {
  const isUser = message.role === "user";

  return (
    <View style={{
      alignSelf: isUser ? "flex-end" : "flex-start",
      maxWidth: "90%",
      marginVertical: 4,
      paddingHorizontal: 12,
      paddingVertical: 8,
      backgroundColor: isUser ? colors.accent.default : colors.bg.raised,
      borderRadius: radius.md,
      borderWidth: isUser ? 0 : 1,
      borderColor: colors.bg.overlay,
    }}>
      {(message.parts || []).map((part, i) => (
        <MessagePartView key={i} part={part} colors={colors} fonts={fonts} radius={radius} />
      ))}
    </View>
  );
}

// ============================================================================
// Permission Dialog
// ============================================================================

function PermissionDialog({ permission, colors, radius, fonts, onReply }: {
  permission: AIPermission;
  colors: any;
  radius: any;
  fonts: any;
  onReply: (approved: boolean) => void;
}) {
  return (
    <Modal transparent animationType="fade">
      <View style={styles.modalOverlay}>
        <View style={[styles.modalContent, { backgroundColor: colors.bg.raised, borderRadius: radius.md, borderColor: colors.bg.overlay }]}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 12 }}>
            <AlertTriangle size={20} color={colors.warning?.default || "#f59e0b"} strokeWidth={2} />
            <Text style={{ color: colors.fg.default, fontSize: 15, fontWeight: "600" }}>Permission Request</Text>
          </View>
          <Text style={{ color: colors.fg.default, fontSize: 13, fontFamily: fonts.mono.regular, marginBottom: 8 }}>
            {permission.title || permission.type}
          </Text>
          {permission.metadata && Object.keys(permission.metadata).length > 0 && (
            <Text style={{ color: colors.fg.muted, fontSize: 11, fontFamily: fonts.mono.regular, marginBottom: 16 }}>
              {JSON.stringify(permission.metadata, null, 2)}
            </Text>
          )}
          <View style={{ flexDirection: "row", gap: 10, justifyContent: "flex-end" }}>
            <TouchableOpacity
              onPress={() => onReply(false)}
              style={[styles.permissionBtn, { backgroundColor: colors.bg.overlay, borderRadius: radius.sm }]}
              activeOpacity={0.7}
            >
              <Text style={{ color: colors.fg.default, fontSize: 13, fontWeight: "600" }}>Deny</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => onReply(true)}
              style={[styles.permissionBtn, { backgroundColor: colors.accent.default, borderRadius: radius.sm }]}
              activeOpacity={0.7}
            >
              <Text style={{ color: colors.accent.fg, fontSize: 13, fontWeight: "600" }}>Approve</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

// ============================================================================
// API Key Setup
// ============================================================================

function ApiKeySetup({ providers, colors, radius, fonts, onSetKey }: {
  providers: AIProvider[];
  colors: any;
  radius: any;
  fonts: any;
  onSetKey: (providerId: string, key: string) => void;
}) {
  const [selectedProvider, setSelectedProvider] = useState<string>(providers[0]?.id || "");
  const [keyInput, setKeyInput] = useState("");

  return (
    <View style={{ flex: 1, justifyContent: "center", alignItems: "center", padding: 24 }}>
      <Key size={40} color={colors.fg.muted} strokeWidth={1.5} />
      <Text style={{ color: colors.fg.default, fontSize: 16, fontWeight: "600", marginTop: 16, marginBottom: 8 }}>
        API Key Required
      </Text>
      <Text style={{ color: colors.fg.muted, fontSize: 13, textAlign: "center", marginBottom: 24 }}>
        Configure an API key for your AI provider to get started.
      </Text>

      {providers.map((p) => (
        <TouchableOpacity
          key={p.id}
          onPress={() => setSelectedProvider(p.id)}
          style={{
            flexDirection: "row", alignItems: "center", gap: 8,
            padding: 12, marginBottom: 8, width: "100%",
            backgroundColor: selectedProvider === p.id ? colors.bg.overlay : colors.bg.raised,
            borderRadius: radius.sm, borderWidth: 1, borderColor: colors.bg.overlay,
          }}
          activeOpacity={0.7}
        >
          <View style={{
            width: 16, height: 16, borderRadius: 8,
            borderWidth: 2, borderColor: selectedProvider === p.id ? colors.accent.default : colors.fg.muted,
            backgroundColor: selectedProvider === p.id ? colors.accent.default : "transparent",
          }} />
          <Text style={{ color: colors.fg.default, fontSize: 13 }}>{p.name || p.id}</Text>
        </TouchableOpacity>
      ))}

      <TextInput
        style={{
          width: "100%", padding: 12, marginTop: 8,
          backgroundColor: colors.bg.overlay, borderRadius: radius.sm,
          color: colors.fg.default, fontSize: 13, fontFamily: fonts.mono.regular,
        }}
        placeholder="Paste API key here..."
        placeholderTextColor={colors.fg.subtle}
        value={keyInput}
        onChangeText={setKeyInput}
        secureTextEntry
        autoCapitalize="none"
      />

      <TouchableOpacity
        onPress={() => {
          if (selectedProvider && keyInput.trim()) {
            onSetKey(selectedProvider, keyInput.trim());
            setKeyInput("");
          }
        }}
        style={{
          marginTop: 16, paddingHorizontal: 24, paddingVertical: 12,
          backgroundColor: keyInput.trim() ? colors.accent.default : colors.bg.overlay,
          borderRadius: radius.md,
        }}
        disabled={!keyInput.trim()}
        activeOpacity={0.7}
      >
        <Text style={{ color: keyInput.trim() ? colors.accent.fg : colors.fg.subtle, fontSize: 14, fontWeight: "600" }}>
          Save Key
        </Text>
      </TouchableOpacity>
    </View>
  );
}

// ============================================================================
// Dropdown component
// ============================================================================

function Dropdown({
  label,
  icon,
  options,
  selectedId,
  onSelect,
  isOpen,
  onToggle,
  colors,
  radius,
  width,
}: {
  label: string;
  icon?: React.ComponentType<any>;
  options: { id: string; name: string; icon?: React.ComponentType<any> }[];
  selectedId: string;
  onSelect: (id: string) => void;
  isOpen: boolean;
  onToggle: () => void;
  colors: any;
  radius: any;
  width: number;
}) {
  const selected = options.find((o) => o.id === selectedId);

  return (
    <View style={[styles.dropdownWrapper, { width }]}>
      <TouchableOpacity
        style={[
          styles.dropdownButton,
          { backgroundColor: colors.bg.overlay, width, borderRadius: radius.sm },
        ]}
        onPress={onToggle}
        activeOpacity={0.7}
      >
        {icon && React.createElement(icon, {
          size: 14,
          color: colors.fg.muted,
          strokeWidth: 2,
          style: { marginRight: 6 }
        })}
        <Text
          style={[styles.dropdownButtonText, { color: colors.fg.default }]}
          numberOfLines={1}
        >
          {selected?.name || label}
        </Text>
        <View style={{ flex: 1 }} />
        {isOpen ? (
          <ChevronUp size={12} color={colors.fg.muted} strokeWidth={2} />
        ) : (
          <ChevronDown size={12} color={colors.fg.muted} strokeWidth={2} />
        )}
      </TouchableOpacity>

      {isOpen && (
        <View
          style={[
            styles.dropdownMenu,
            {
              backgroundColor: colors.bg.raised,
              borderColor: colors.bg.overlay,
              borderRadius: radius.sm,
              width,
            },
          ]}
        >
          {options.map((option) => (
            <TouchableOpacity
              key={option.id}
              style={[
                styles.dropdownItem,
                selectedId === option.id && {
                  backgroundColor: colors.bg.overlay,
                },
              ]}
              onPress={() => {
                onSelect(option.id);
                onToggle();
              }}
            >
              {option.icon && React.createElement(option.icon, {
                size: 14,
                color: selectedId === option.id ? colors.accent.default : colors.fg.muted,
                strokeWidth: 2,
                style: { marginRight: 8 }
              })}
              <Text
                style={[
                  styles.dropdownItemText,
                  {
                    color:
                      selectedId === option.id
                        ? colors.accent.default
                        : colors.fg.default,
                  },
                ]}
              >
                {option.name}
              </Text>
              {selectedId === option.id && (
                <Check
                  size={14}
                  color={colors.accent.default}
                  strokeWidth={3}
                  style={{ marginLeft: "auto" }}
                />
              )}
            </TouchableOpacity>
          ))}
        </View>
      )}
    </View>
  );
}

// ============================================================================
// Main AI Panel
// ============================================================================

export default function AIPanel({ instanceId, isActive }: PluginPanelProps) {
  const { colors, radius, fonts } = useTheme();
  const { status } = useConnection();

  // Session state
  const [tabs, setTabs] = useState<AITab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [messagesMap, setMessagesMap] = useState<Record<string, AIMessage[]>>({});

  // Config state
  const [agents, setAgents] = useState<{ id: string; name: string; icon?: React.ComponentType<any> }[]>([
    { id: "build", name: "Build", icon: Hammer },
    { id: "plan", name: "Plan", icon: Map },
  ]);
  const [modelOptions, setModelOptions] = useState<{ id: string; name: string }[]>([]);
  const [selectedAgent, setSelectedAgent] = useState("build");
  const [selectedModel, setSelectedModel] = useState("");
  const [providers, setProviders] = useState<AIProvider[]>([]);

  // UI state
  const [inputText, setInputText] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [pendingPermission, setPendingPermission] = useState<AIPermission | null>(null);
  const [isModelDropdownOpen, setIsModelDropdownOpen] = useState(false);
  const [isModeDropdownOpen, setIsModeDropdownOpen] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [inputHeight, setInputHeight] = useState(42);
  const [needsApiKey, setNeedsApiKey] = useState(false);
  const [isInitialized, setIsInitialized] = useState(false);

  // Refs
  const inputRef = useRef<TextInput>(null);
  const messagesListRef = useRef<FlatList>(null);
  const activeSessionId = useMemo(() => {
    return tabs.find((t) => t.id === activeTabId)?.sessionId || null;
  }, [tabs, activeTabId]);

  // AI hook with event handling
  const ai = useAI({
    onEvent: useCallback((event: AIEvent) => {
      const props = event.properties || {};

      switch (event.type) {
        case "message.updated": {
          const msg = props as unknown as AIMessage;
          const sessId = (props.sessionID as string) || (props.sessionId as string);
          if (sessId && msg.id) {
            setMessagesMap((prev) => {
              const existing = prev[sessId] || [];
              const idx = existing.findIndex((m) => m.id === msg.id);
              if (idx >= 0) {
                const updated = [...existing];
                updated[idx] = msg;
                return { ...prev, [sessId]: updated };
              }
              return { ...prev, [sessId]: [...existing, msg] };
            });
          }
          break;
        }
        case "message.part.updated": {
          const sessId = (props.sessionID as string) || (props.sessionId as string);
          const msgId = props.messageID as string || props.messageId as string;
          const part = props.part as AIPart;
          const partIndex = props.index as number;
          if (sessId && msgId && part != null) {
            setMessagesMap((prev) => {
              const existing = prev[sessId] || [];
              const msgIdx = existing.findIndex((m) => m.id === msgId);
              if (msgIdx >= 0) {
                const updated = [...existing];
                const msg = { ...updated[msgIdx], parts: [...(updated[msgIdx].parts || [])] };
                if (partIndex != null && partIndex < msg.parts.length) {
                  msg.parts[partIndex] = part;
                } else {
                  // Append or update by matching type index
                  msg.parts = [...msg.parts];
                  if (partIndex != null) {
                    while (msg.parts.length <= partIndex) msg.parts.push({ type: "text" });
                    msg.parts[partIndex] = part;
                  } else {
                    msg.parts.push(part);
                  }
                }
                updated[msgIdx] = msg;
                return { ...prev, [sessId]: updated };
              }
              return prev;
            });
          }
          break;
        }
        case "session.status": {
          const s = (props.status as string) || "";
          setIsStreaming(s === "busy" || s === "running");
          break;
        }
        case "session.idle": {
          setIsStreaming(false);
          break;
        }
        case "permission.updated": {
          setPendingPermission(props as unknown as AIPermission);
          break;
        }
        case "permission.replied": {
          setPendingPermission(null);
          break;
        }
        case "session.error":
        case "prompt_error": {
          const errMsg = (props.error as string) || "An error occurred";
          Alert.alert("AI Error", errMsg);
          setIsStreaming(false);
          break;
        }
      }
    }, []),
  });

  // Initialize on connection
  useEffect(() => {
    if (status !== "connected" || isInitialized) return;

    const init = async () => {
      try {
        // Fetch agents
        try {
          const agentsList = await ai.getAgents();
          if (Array.isArray(agentsList) && agentsList.length > 0) {
            const mapped = (agentsList as AIAgent[]).map((a) => ({
              id: a.name || a.mode,
              name: a.name || a.mode,
              icon: a.mode === "plan" ? Map : Hammer,
            }));
            setAgents(mapped);
            setSelectedAgent(mapped[0].id);
          }
        } catch {
          // Use defaults
        }

        // Fetch providers + models
        try {
          const providersList = await ai.getProviders();
          if (Array.isArray(providersList)) {
            setProviders(providersList as AIProvider[]);
            const models: { id: string; name: string }[] = [];
            let hasConfiguredKey = false;

            for (const p of providersList as AIProvider[]) {
              if (p.models) {
                for (const [modelId, model] of Object.entries(p.models)) {
                  models.push({
                    id: `${p.id}:${modelId}`,
                    name: (model as any).name || modelId,
                  });
                }
              }
              // Check if provider is configured (heuristic)
              if ((p as any).configured || (p as any).hasKey) {
                hasConfiguredKey = true;
              }
            }

            if (models.length > 0) {
              setModelOptions(models);
              setSelectedModel(models[0].id);
              hasConfiguredKey = true; // if models available, keys probably configured
            }
            setNeedsApiKey(!hasConfiguredKey && models.length === 0);
          }
        } catch {
          // Use defaults
        }

        // Fetch existing sessions
        try {
          const sessions = await ai.listSessions();
          if (Array.isArray(sessions) && sessions.length > 0) {
            const sessionTabs: AITab[] = (sessions as AISession[]).map((s, i) => ({
              id: s.id,
              title: s.title || `Session ${i + 1}`,
              sessionId: s.id,
            }));
            setTabs(sessionTabs);
            setActiveTabId(sessionTabs[0].id);

            // Load messages for the first session
            try {
              const msgs = await ai.getMessages(sessionTabs[0].sessionId!);
              if (Array.isArray(msgs)) {
                setMessagesMap((prev) => ({ ...prev, [sessionTabs[0].sessionId!]: msgs as AIMessage[] }));
              }
            } catch {
              // ok
            }
          }
        } catch {
          // No existing sessions
        }

        setIsInitialized(true);
      } catch (err) {
        console.error("AI init error:", err);
        setIsInitialized(true);
      }
    };

    init();
  }, [status, isInitialized, ai]);

  // Reset on disconnect
  useEffect(() => {
    if (status === "disconnected" || status === "error") {
      setIsInitialized(false);
    }
  }, [status]);

  // Scroll to bottom on new messages
  const currentMessages = activeSessionId ? messagesMap[activeSessionId] || [] : [];
  useEffect(() => {
    if (currentMessages.length > 0) {
      setTimeout(() => {
        messagesListRef.current?.scrollToEnd({ animated: true });
      }, 100);
    }
  }, [currentMessages.length]);

  // Tab management
  const getTabWidth = useCallback(() => 120, []);

  const createNewTab = async () => {
    try {
      const session = await ai.createSession(`Session ${tabs.length + 1}`);
      const newTab: AITab = {
        id: session.id,
        title: session.title || `Session ${tabs.length + 1}`,
        sessionId: session.id,
      };
      setTabs((prev) => [...prev, newTab]);
      setActiveTabId(newTab.id);
      setInputText("");
    } catch (err) {
      // Fallback: create a local tab, will get a session on first prompt
      const newId = Date.now().toString();
      const newTab: AITab = {
        id: newId,
        title: `Session ${tabs.length + 1}`,
      };
      setTabs((prev) => [...prev, newTab]);
      setActiveTabId(newId);
      setInputText("");
    }
  };

  const closeTab = async (tabId: string) => {
    const tab = tabs.find((t) => t.id === tabId);
    if (tab?.sessionId) {
      try {
        await ai.deleteSession(tab.sessionId);
      } catch {
        // ok
      }
    }

    const newTabs = tabs.filter((t) => t.id !== tabId);
    setTabs(newTabs);

    if (activeTabId === tabId && newTabs.length > 0) {
      const index = tabs.findIndex((t) => t.id === tabId);
      const newActiveTab = newTabs[Math.max(0, index - 1)];
      setActiveTabId(newActiveTab.id);
    } else if (newTabs.length === 0) {
      setActiveTabId(null);
    }
  };

  const handleTabPress = useCallback(async (tabId: string) => {
    setActiveTabId(tabId);
    const tab = tabs.find((t) => t.id === tabId);
    if (tab?.sessionId && !messagesMap[tab.sessionId]) {
      try {
        const msgs = await ai.getMessages(tab.sessionId);
        if (Array.isArray(msgs)) {
          setMessagesMap((prev) => ({ ...prev, [tab.sessionId!]: msgs as AIMessage[] }));
        }
      } catch {
        // ok
      }
    }
  }, [tabs, messagesMap, ai]);

  // Get selected model ref
  const getModelRef = useCallback((): ModelRef | undefined => {
    if (!selectedModel || !selectedModel.includes(":")) return undefined;
    const [providerID, modelID] = selectedModel.split(":");
    return { providerID, modelID };
  }, [selectedModel]);

  // Send message / handle slash commands
  const sendMessage = async () => {
    const text = inputText.trim();
    if (!text) return;

    setInputText("");
    setInputHeight(42);
    Keyboard.dismiss();

    // Get or create session
    let sessId = activeSessionId;
    if (!sessId) {
      try {
        const session = await ai.createSession(`Session ${tabs.length + 1}`);
        sessId = session.id;
        const newTab: AITab = {
          id: session.id,
          title: session.title || `Session ${tabs.length + 1}`,
          sessionId: session.id,
        };
        if (tabs.length === 0) {
          setTabs([newTab]);
        } else {
          setTabs((prev) =>
            prev.map((t) =>
              t.id === activeTabId ? { ...t, sessionId: session.id } : t
            )
          );
        }
        setActiveTabId(session.id);
      } catch (err) {
        Alert.alert("Error", "Failed to create AI session");
        return;
      }
    }

    // Handle slash commands
    if (text.startsWith("/")) {
      const cmd = text.slice(1).split(" ")[0].toLowerCase();
      try {
        switch (cmd) {
          case "undo": {
            const msgs = messagesMap[sessId] || [];
            const lastUserMsg = [...msgs].reverse().find((m) => m.role === "user");
            if (lastUserMsg) await ai.revert(sessId, lastUserMsg.id);
            break;
          }
          case "redo":
            await ai.unrevert(sessId);
            break;
          case "share": {
            const result = await ai.share(sessId);
            Alert.alert("Shared", `URL: ${(result as any).url || JSON.stringify(result)}`);
            break;
          }
          case "abort":
            await ai.abort(sessId);
            setIsStreaming(false);
            break;
          case "init":
            await ai.runCommand(sessId, "init");
            break;
          default:
            // Treat as regular prompt
            await ai.sendPrompt(sessId, text, getModelRef());
            setIsStreaming(true);
        }
      } catch (err) {
        Alert.alert("Error", (err as Error).message);
      }
      return;
    }

    // Regular prompt
    try {
      // Add optimistic user message
      const optimisticMsg: AIMessage = {
        id: `opt-${Date.now()}`,
        role: "user",
        parts: [{ type: "text", text }],
      };
      setMessagesMap((prev) => ({
        ...prev,
        [sessId!]: [...(prev[sessId!] || []), optimisticMsg],
      }));

      await ai.sendPrompt(sessId, text, getModelRef());
      setIsStreaming(true);
    } catch (err) {
      Alert.alert("Error", (err as Error).message);
    }
  };

  // Permission reply
  const handlePermissionReply = async (approved: boolean) => {
    if (!pendingPermission || !activeSessionId) return;
    try {
      await ai.replyPermission(activeSessionId, pendingPermission.id, approved);
    } catch (err) {
      console.error("Permission reply error:", err);
    }
    setPendingPermission(null);
  };

  // API key handler
  const handleSetApiKey = async (providerId: string, key: string) => {
    try {
      await ai.setAuth(providerId, key);
      setNeedsApiKey(false);
      // Re-init to fetch models
      setIsInitialized(false);
    } catch (err) {
      Alert.alert("Error", (err as Error).message);
    }
  };

  // Tab renderer
  const renderAITab = useCallback(
    (
      tab: AITab,
      isActive: boolean,
      isLast: boolean,
      showDivider: boolean,
      targetWidth: number,
      onPress: () => void,
      onClose: () => void,
      isNew: boolean
    ) => (
      <TouchableOpacity
        onPress={onPress}
        activeOpacity={0.7}
        style={[
          styles.tab,
          {
            width: targetWidth,
            backgroundColor: isActive ? colors.bg.base : "transparent",
            borderColor: isActive ? colors.bg.overlay : "transparent",
            borderRadius: radius.sm,
            marginRight: isLast ? 0 : 2,
          },
        ]}
      >
        {showDivider && (
          <View
            style={[styles.divider, { backgroundColor: colors.bg.overlay }]}
          />
        )}

        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            flex: 1,
            marginRight: isActive ? 6 : 0,
          }}
        >
          <Sparkles
            size={16}
            color={isActive ? colors.fg.default : colors.fg.muted}
            strokeWidth={2}
            style={{ marginRight: 8 }}
          />
          <Text
            numberOfLines={1}
            style={[
              styles.tabTitle,
              { color: isActive ? colors.fg.default : colors.fg.muted },
            ]}
          >
            {tab.title}
          </Text>
        </View>

        {isActive && (
          <TouchableOpacity
            onPress={onClose}
            style={[styles.closeButton, { backgroundColor: colors.bg.raised, borderRadius: radius.full }]}
          >
            <X size={12} color={colors.fg.default} strokeWidth={2} />
          </TouchableOpacity>
        )}
      </TouchableOpacity>
    ),
    [colors, radius]
  );

  // Render message item
  const renderMessageItem = useCallback(({ item }: { item: AIMessage }) => (
    <MessageBubble message={item} colors={colors} fonts={fonts} radius={radius} />
  ), [colors, fonts, radius]);

  const hasMessages = currentMessages.length > 0;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg.base }}>
      {/* Permission Dialog */}
      {pendingPermission && (
        <PermissionDialog
          permission={pendingPermission}
          colors={colors}
          radius={radius}
          fonts={fonts}
          onReply={handlePermissionReply}
        />
      )}

      {/* Header */}
      <PluginHeader
        tabs={tabs}
        activeTabId={activeTabId || undefined}
        onTabPress={handleTabPress}
        onTabClose={closeTab}
        onNewTab={createNewTab}
        renderTab={renderAITab}
        colors={colors}
        getTabWidth={getTabWidth}
      />

      {/* Content */}
      <View style={{ flex: 1, position: "relative" }}>
        {/* API Key Setup */}
        {needsApiKey && providers.length > 0 ? (
          <ApiKeySetup
            providers={providers}
            colors={colors}
            radius={radius}
            fonts={fonts}
            onSetKey={handleSetApiKey}
          />
        ) : tabs.length === 0 ? (
          <View
            style={{
              flex: 1,
              justifyContent: "center",
              alignItems: "center",
              gap: 16,
            }}
          >
            <Sparkles
              size={48}
              color={colors.fg.muted}
              strokeWidth={1.5}
            />
            <Text style={{ color: colors.fg.muted, fontSize: 16 }}>
              No AI sessions open
            </Text>
            <TouchableOpacity
              onPress={createNewTab}
              style={{
                flexDirection: "row",
                alignItems: "center",
                backgroundColor: colors.accent.default,
                paddingHorizontal: 16,
                paddingVertical: 10,
                borderRadius: radius.md,
                gap: 6,
                marginTop: 8,
              }}
            >
              <Plus size={18} color={colors.accent.fg} strokeWidth={2} />
              <Text
                style={{
                  color: colors.accent.fg,
                  fontSize: 14,
                  fontWeight: "600",
                }}
              >
                New Session
              </Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={{ flex: 1, justifyContent: "flex-end" }}>
            {/* Messages or Welcome Screen */}
            {hasMessages ? (
              <FlatList
                ref={messagesListRef}
                data={currentMessages}
                keyExtractor={(item) => item.id}
                renderItem={renderMessageItem}
                style={{ flex: 1 }}
                contentContainerStyle={{ padding: 12, paddingBottom: 8 }}
                onContentSizeChange={() => {
                  messagesListRef.current?.scrollToEnd({ animated: true });
                }}
              />
            ) : (
              <View style={styles.logoContainer}>
                <View style={styles.logoWrapper}>
                  <Image
                    source={require("@/assets/opencode-wordmark-simple-dark.png")}
                    style={[styles.logo, { tintColor: colors.fg.default }]}
                    resizeMode="contain"
                  />
                  <Text style={[styles.versionText, { color: colors.fg.subtle, fontFamily: fonts.mono.regular }]}>v1.1.28</Text>
                </View>
                <View style={styles.promptButtonsContainer}>
                  <TouchableOpacity
                    style={[styles.promptButton, { borderColor: colors.bg.overlay, borderRadius: radius.sm }]}
                    onPress={() => setInputText("Walk me through this codebase and explain how it all fits together")}
                    activeOpacity={0.7}
                  >
                    <Text style={[styles.promptButtonText, { color: colors.fg.muted, fontFamily: fonts.mono.regular }]}>Walk me through this codebase</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.promptButton, { borderColor: colors.bg.overlay, borderRadius: radius.sm }]}
                    onPress={() => setInputText("Find the bug and fix it, then explain what was wrong")}
                    activeOpacity={0.7}
                  >
                    <Text style={[styles.promptButtonText, { color: colors.fg.muted, fontFamily: fonts.mono.regular }]}>Find the bug and fix it</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.promptButton, { borderColor: colors.bg.overlay, borderRadius: radius.sm }]}
                    onPress={() => setInputText("Refactor this to be cleaner and more maintainable")}
                    activeOpacity={0.7}
                  >
                    <Text style={[styles.promptButtonText, { color: colors.fg.muted, fontFamily: fonts.mono.regular }]}>Refactor this to be cleaner</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.promptButton, { borderColor: colors.bg.overlay, borderRadius: radius.sm }]}
                    onPress={() => setInputText("Write tests for the most critical parts of this code")}
                    activeOpacity={0.7}
                  >
                    <Text style={[styles.promptButtonText, { color: colors.fg.muted, fontFamily: fonts.mono.regular }]}>Write tests for the critical parts</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}

            {/* Options bar */}
            <View style={styles.optionsBar}>
              {/* Mode/Agent dropdown */}
              <Dropdown
                label="Mode"
                icon={agents.find((a) => a.id === selectedAgent)?.icon}
                options={agents}
                selectedId={selectedAgent}
                onSelect={(id) => setSelectedAgent(id)}
                isOpen={isModeDropdownOpen}
                onToggle={() => {
                  setIsModelDropdownOpen(false);
                  setIsMenuOpen(false);
                  setIsModeDropdownOpen(!isModeDropdownOpen);
                }}
                colors={colors}
                radius={radius}
                width={100}
              />

              {/* Model dropdown */}
              <Dropdown
                label="Model"
                icon={Sparkles}
                options={modelOptions.length > 0 ? modelOptions : [
                  { id: "claude-sonnet", name: "Claude Sonnet" },
                  { id: "claude-opus", name: "Claude Opus" },
                  { id: "gpt-4o", name: "GPT-4o" },
                  { id: "gemini-pro", name: "Gemini Pro" },
                ]}
                selectedId={selectedModel || "claude-sonnet"}
                onSelect={(id) => setSelectedModel(id)}
                isOpen={isModelDropdownOpen}
                onToggle={() => {
                  setIsModeDropdownOpen(false);
                  setIsMenuOpen(false);
                  setIsModelDropdownOpen(!isModelDropdownOpen);
                }}
                colors={colors}
                radius={radius}
                width={140}
              />

              <View style={{ flex: 1 }} />

              {/* Image button */}
              <TouchableOpacity
                style={[styles.actionButton, { backgroundColor: colors.bg.overlay, borderRadius: radius.sm }]}
                onPress={() => console.log("Image picker")}
                activeOpacity={0.7}
              >
                <ImageIcon size={16} color={colors.fg.muted} strokeWidth={2} />
              </TouchableOpacity>

              {/* More menu button */}
              <View style={{ position: "relative" }}>
                {isMenuOpen && (
                  <TouchableOpacity
                    style={styles.menuBackdrop}
                    onPress={() => setIsMenuOpen(false)}
                    activeOpacity={1}
                  />
                )}
                <TouchableOpacity
                  style={[styles.actionButton, { backgroundColor: isMenuOpen ? colors.bg.raised : colors.bg.overlay, borderRadius: radius.sm }]}
                  onPress={() => {
                    setIsModeDropdownOpen(false);
                    setIsModelDropdownOpen(false);
                    setIsMenuOpen(!isMenuOpen);
                  }}
                  activeOpacity={0.7}
                >
                  <MoreHorizontal size={16} color={colors.fg.muted} strokeWidth={2} />
                </TouchableOpacity>

                {isMenuOpen && (
                  <View style={[styles.moreMenu, { backgroundColor: colors.bg.raised, borderColor: colors.bg.overlay, borderRadius: radius.sm }]}>
                    {/* Abort — only when streaming */}
                    {isStreaming && (
                      <TouchableOpacity
                        style={styles.moreMenuItem}
                        onPress={() => {
                          setIsMenuOpen(false);
                          activeSessionId && ai.abort(activeSessionId).then(() => setIsStreaming(false));
                        }}
                        activeOpacity={0.7}
                      >
                        <Square size={14} color={colors.fg.muted} strokeWidth={2} />
                        <Text style={[styles.moreMenuItemText, { color: colors.fg.default }]}>Stop</Text>
                      </TouchableOpacity>
                    )}

                    <TouchableOpacity
                      style={styles.moreMenuItem}
                      onPress={() => {
                        setIsMenuOpen(false);
                        if (!activeSessionId) return;
                        const lastUserMsg = [...currentMessages].reverse().find((m) => m.role === "user");
                        if (lastUserMsg) ai.revert(activeSessionId, lastUserMsg.id).catch(() => {});
                      }}
                      activeOpacity={0.7}
                    >
                      <Undo2 size={14} color={colors.fg.muted} strokeWidth={2} />
                      <Text style={[styles.moreMenuItemText, { color: colors.fg.default }]}>Undo</Text>
                    </TouchableOpacity>

                    <TouchableOpacity
                      style={styles.moreMenuItem}
                      onPress={() => {
                        setIsMenuOpen(false);
                        activeSessionId && ai.unrevert(activeSessionId).catch(() => {});
                      }}
                      activeOpacity={0.7}
                    >
                      <Redo2 size={14} color={colors.fg.muted} strokeWidth={2} />
                      <Text style={[styles.moreMenuItemText, { color: colors.fg.default }]}>Redo</Text>
                    </TouchableOpacity>

                    <TouchableOpacity
                      style={styles.moreMenuItem}
                      onPress={async () => {
                        setIsMenuOpen(false);
                        if (!activeSessionId) return;
                        try {
                          const result = await ai.share(activeSessionId);
                          Alert.alert("Shared", `URL: ${(result as any).url || JSON.stringify(result)}`);
                        } catch {}
                      }}
                      activeOpacity={0.7}
                    >
                      <Share2 size={14} color={colors.fg.muted} strokeWidth={2} />
                      <Text style={[styles.moreMenuItemText, { color: colors.fg.default }]}>Share</Text>
                    </TouchableOpacity>

                  </View>
                )}
              </View>
            </View>

            {/* Input area */}
            <View style={styles.inputContainer}>
              <View
                style={[
                  styles.inputWrapper,
                  {
                    backgroundColor: colors.bg.overlay,
                    minHeight: inputHeight,
                    borderRadius: radius.sm,
                  },
                ]}
              >
                <TextInput
                  ref={inputRef}
                  style={[
                    styles.input,
                    {
                      color: colors.fg.default,
                      maxHeight: 150,
                    },
                  ]}
                  placeholder="Ask anything..."
                  placeholderTextColor={colors.fg.default}
                  value={inputText}
                  onChangeText={setInputText}
                  multiline
                  onContentSizeChange={(e) => {
                    const newHeight = Math.max(42, e.nativeEvent.contentSize.height + 16);
                    setInputHeight(Math.min(newHeight, 150));
                  }}
                  onSubmitEditing={sendMessage}
                  blurOnSubmit={false}
                />

                <TouchableOpacity
                  style={[
                    styles.sendButton,
                    {
                      backgroundColor: inputText.trim()
                        ? colors.accent.default
                        : colors.bg.raised,
                      borderRadius: radius.sm,
                    },
                  ]}
                  onPress={sendMessage}
                  disabled={!inputText.trim()}
                  activeOpacity={0.7}
                >
                  {isStreaming ? (
                    <ActivityIndicator size="small" color={colors.accent.fg} />
                  ) : (
                    <ArrowUp
                      size={18}
                      color={inputText.trim() ? colors.accent.fg : colors.fg.subtle}
                      strokeWidth={2}
                    />
                  )}
                </TouchableOpacity>
              </View>
            </View>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // Tab styles
  tab: {
    height: 35,
    marginBottom: 12,
    paddingLeft: 8,
    paddingRight: 6,
    borderWidth: 0.7,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  divider: {
    position: "absolute",
    right: -2,
    width: 1,
    height: 20,
    top: 7,
  },
  tabTitle: {
    fontSize: 13,
    flex: 1,
  },
  closeButton: {
    width: 20,
    height: 20,
    alignItems: "center",
    justifyContent: "center",
    padding: 0,
  },

  // Logo
  logoContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  logoWrapper: {
    position: "relative",
  },
  logo: {
    width: 320,
    height: 80,
  },
  versionText: {
    position: "absolute",
    bottom: 0,
    right: 0,
    fontSize: 10,
  },
  promptButtonsContainer: {
    marginTop: 24,
    width: 320,
    gap: 8,
  },
  promptButton: {
    paddingVertical: 12,
    paddingHorizontal: 16,
    alignItems: "center",
    borderWidth: 1,
  },
  promptButtonText: {
    fontSize: 11,
  },

  // Options bar
  optionsBar: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 8,
  },

  // Dropdown styles
  dropdownWrapper: {
    position: "relative",
  },
  dropdownButton: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  dropdownButtonText: {
    fontSize: 12,
    fontWeight: "500",
  },
  dropdownMenu: {
    position: "absolute",
    bottom: "100%",
    left: 0,
    borderWidth: 1,
    marginBottom: 2,
    overflow: "hidden",
  },
  dropdownItem: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  dropdownItemText: {
    fontSize: 13,
  },

  // More menu button
  actionButton: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  menuBackdrop: {
    position: "absolute",
    top: -9999,
    left: -9999,
    right: -9999,
    bottom: -9999,
    zIndex: 9,
  },
  moreMenu: {
    position: "absolute",
    zIndex: 10,
    bottom: "100%",
    right: 0,
    marginBottom: 4,
    borderWidth: 1,
    minWidth: 150,
    overflow: "hidden",
  },
  moreMenuItem: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 11,
    gap: 10,
  },
  moreMenuItemText: {
    fontSize: 13,
  },

  // Input styles
  inputContainer: {
    paddingHorizontal: 12,
    paddingTop: 0,
    paddingBottom: 16,
  },
  inputWrapper: {
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: 16,
    paddingRight: 6,
    paddingVertical: 6,
  },
  input: {
    flex: 1,
    fontSize: 14,
    paddingVertical: 6,
    maxHeight: 150,
    textAlignVertical: "center",
  },
  sendButton: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: 8,
  },

  // Modal
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  modalContent: {
    width: "100%",
    maxWidth: 400,
    padding: 20,
    borderWidth: 1,
  },
  permissionBtn: {
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
});
