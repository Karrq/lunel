import React, { memo, useCallback, useState } from 'react';
import {
  Keyboard,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { ArrowRight, FileCode2, RefreshCw, Search, TriangleAlert } from 'lucide-react-native';
import PluginHeader, { usePluginHeaderHeight } from '@/components/PluginHeader';
import Loading from '@/components/Loading';
import NotConnected from '@/components/NotConnected';
import { useTheme } from '@/contexts/ThemeContext';
import { typography } from '@/constants/themes';
import { useApi, ApiError, GrepMatch } from '@/hooks/useApi';
import { usePlugins } from '@/plugins';
import { gPI } from '../../gpi';
import { PluginPanelProps } from '../../types';

function SearchPanel({ isActive }: PluginPanelProps) {
  const { colors, fonts, spacing } = useTheme();
  const headerHeight = usePluginHeaderHeight();
  const { fs, isConnected } = useApi();
  const { openTab } = usePlugins();

  const [query, setQuery] = useState('');
  const [searchPath, setSearchPath] = useState('.');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [results, setResults] = useState<GrepMatch[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);

  const canSearch = query.trim().length > 0 && searchPath.trim().length > 0;

  const runSearch = useCallback(async () => {
    const trimmedQuery = query.trim();
    const trimmedPath = searchPath.trim() || '.';
    if (!trimmedQuery) return;

    Keyboard.dismiss();
    setLoading(true);
    setError(null);
    setHasSearched(true);

    try {
      const matches = await fs.grep(trimmedQuery, trimmedPath, {
        caseSensitive,
        maxResults: 200,
      });
      setResults(matches);
    } catch (err) {
      setResults([]);
      setError(err instanceof ApiError ? err.message : 'Failed to search the codebase');
    } finally {
      setLoading(false);
    }
  }, [caseSensitive, fs, query, searchPath]);

  const openMatch = useCallback(async (match: GrepMatch) => {
    await gPI.editor.openFile(match.file);
    openTab('editor');
  }, [openTab]);

  if (!isConnected) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg.base, paddingTop: headerHeight }}>
        <PluginHeader title="Codebase Search" colors={colors} />
        <NotConnected colors={colors} fonts={fonts} />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg.base, paddingTop: headerHeight }}>
      <PluginHeader
        title="Codebase Search"
        colors={colors}
        rightAccessory={
          <TouchableOpacity
            onPress={() => { if (canSearch && !loading) void runSearch(); }}
            style={{ padding: 8, opacity: canSearch && !loading ? 1 : 0.4 }}
            disabled={!canSearch || loading}
          >
            <RefreshCw size={20} color={colors.fg.muted} strokeWidth={2} />
          </TouchableOpacity>
        }
      />

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingHorizontal: spacing[3],
          paddingTop: spacing[3],
          paddingBottom: spacing[6],
          gap: spacing[3],
        }}
        keyboardShouldPersistTaps="handled"
      >
        <View style={{ gap: spacing[3] }}>
          <View style={styles.fieldGroup}>
            <Text style={[styles.label, { color: colors.fg.muted, fontFamily: fonts.sans.medium }]}>
              Pattern
            </Text>
            <View style={[styles.inputShell, { backgroundColor: colors.bg.raised, borderColor: colors.border.secondary, borderRadius: 10 }]}>
              <Search size={15} color={colors.fg.subtle} strokeWidth={2} />
              <TextInput
                style={[styles.input, { color: colors.fg.default, fontFamily: fonts.mono.regular }]}
                placeholder="function handleFsGrep"
                placeholderTextColor={colors.fg.subtle}
                value={query}
                onChangeText={setQuery}
                autoCapitalize="none"
                autoCorrect={false}
                onSubmitEditing={() => { if (canSearch && !loading) void runSearch(); }}
              />
            </View>
          </View>

          <View style={styles.fieldGroup}>
            <Text style={[styles.label, { color: colors.fg.muted, fontFamily: fonts.sans.medium }]}>
              Path
            </Text>
            <View style={[styles.inputShell, { backgroundColor: colors.bg.raised, borderColor: colors.border.secondary, borderRadius: 10 }]}>
              <ArrowRight size={15} color={colors.fg.subtle} strokeWidth={2} />
              <TextInput
                style={[styles.input, { color: colors.fg.default, fontFamily: fonts.mono.regular }]}
                placeholder="."
                placeholderTextColor={colors.fg.subtle}
                value={searchPath}
                onChangeText={setSearchPath}
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>
          </View>

          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              paddingVertical: spacing[1],
            }}
          >
            <View>
              <Text style={{ color: colors.fg.default, fontFamily: fonts.sans.medium, fontSize: typography.body }}>
                Case sensitive
              </Text>
              <Text style={{ color: colors.fg.subtle, fontFamily: fonts.sans.regular, fontSize: typography.caption }}>
                Use exact casing while matching
              </Text>
            </View>
            <Switch
              value={caseSensitive}
              onValueChange={setCaseSensitive}
              trackColor={{ false: colors.bg.raised, true: colors.bg.raised }}
              thumbColor={caseSensitive ? colors.fg.default : colors.fg.subtle}
            />
          </View>

          <TouchableOpacity
            onPress={() => void runSearch()}
            activeOpacity={0.85}
            disabled={!canSearch || loading}
            style={{
              height: 38,
              borderRadius: 10,
              backgroundColor: canSearch && !loading ? colors.accent.default : colors.bg.raised,
              alignItems: 'center',
              justifyContent: 'center',
              opacity: canSearch && !loading ? 1 : 0.55,
            }}
          >
            <Text
              style={{
                color: canSearch && !loading ? colors.bg.base : colors.fg.muted,
                fontFamily: fonts.sans.semibold,
                fontSize: typography.body,
              }}
            >
              Search
            </Text>
          </TouchableOpacity>
        </View>

        {hasSearched ? (
          <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.border.secondary }} />
        ) : null}

        {error ? (
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: spacing[2],
              padding: spacing[3],
              borderRadius: 10,
              backgroundColor: '#ef4444' + '15',
            }}
          >
            <TriangleAlert size={16} color="#ef4444" strokeWidth={2} />
            <Text style={{ flex: 1, color: '#ef4444', fontFamily: fonts.sans.medium, fontSize: 13 }}>
              {error}
            </Text>
          </View>
        ) : null}

        {loading ? (
          <Loading />
        ) : (
          <View style={{ gap: spacing[3] }}>
            {results.map((match, index) => (
              <TouchableOpacity
                key={`${match.file}:${match.line}:${index}`}
                activeOpacity={0.8}
                onPress={() => void openMatch(match)}
                style={{
                  backgroundColor: colors.bg.raised,
                  borderRadius: 10,
                  padding: spacing[3],
                  gap: spacing[3],
                }}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing[2] }}>
                  <FileCode2 size={16} color={colors.fg.default} strokeWidth={2} />
                  <Text
                    style={{ flex: 1, color: colors.fg.default, fontFamily: fonts.sans.regular, fontSize: typography.body }}
                    numberOfLines={1}
                  >
                    {match.file}:{match.line}
                  </Text>
                </View>
                <Text style={{ color: colors.fg.muted, fontFamily: fonts.mono.regular, fontSize: typography.caption }}>
                  {match.content}
                </Text>
              </TouchableOpacity>
            ))}

            {hasSearched && !loading && results.length === 0 ? (
              <View
                style={{
                  alignItems: 'center',
                  justifyContent: 'center',
                  paddingVertical: spacing[8],
                  gap: spacing[2],
                }}
              >
                <Search size={26} color={colors.fg.subtle} strokeWidth={1.8} />
                <Text style={{ color: colors.fg.muted, fontFamily: fonts.sans.medium, fontSize: 14 }}>
                  No matches
                </Text>
              </View>
            ) : null}
          </View>
        )}
      </ScrollView>

      {hasSearched && !loading && results.length > 0 ? (
        <View style={{
          position: 'absolute',
          bottom: 0,
          right: 0,
          backgroundColor: colors.bg.base,
          paddingHorizontal: 10,
          paddingVertical: 5,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
        }}>
          <Text style={{ fontSize: 12, fontFamily: fonts.sans.regular, color: colors.fg.muted }}>
            {results.length} match{results.length !== 1 ? 'es' : ''}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  fieldGroup: {
    gap: 6,
  },
  label: {
    fontSize: 12,
    letterSpacing: 0.2,
  },
  inputShell: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 38,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
  },
  input: {
    flex: 1,
    fontSize: 13,
    paddingVertical: 8,
    outlineStyle: 'none',
  } as any,
});

export default memo(SearchPanel);
