import { Sparkles } from 'lucide-react-native';
import { registerPlugin } from '../../registry';
import { AIAPI } from '../../gpi';
import AIPanel from './Panel';

// AI plugin API implementation
// Note: The real OpenCode integration happens via useAI hook inside Panel.tsx.
// This GPI API provides a simple cross-plugin interface for other plugins to send messages.
const aiApi = (): AIAPI => ({
  sendMessage: async (message: string) => {
    // Cross-plugin messaging is handled by the Panel component via useAI hook
    console.log('[ai] GPI sendMessage:', message);
    return 'Use the AI panel directly for OpenCode integration';
  },
  clearChat: async () => {
    console.log('[ai] GPI clearChat');
  },
});

// Register the AI plugin
registerPlugin({
  id: 'ai',
  name: 'AI',
  type: 'core',
  icon: Sparkles,
  component: AIPanel,
  defaultTitle: 'AI',
  allowMultipleInstances: false,
  api: aiApi,
});

export { AIPanel };
