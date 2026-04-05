import { Search } from 'lucide-react-native';
import { registerPlugin } from '../../registry';
import SearchPanel from './Panel';

registerPlugin({
  id: 'search',
  name: 'Codebase Search',
  type: 'extra',
  icon: Search,
  component: SearchPanel,
  defaultTitle: 'Codebase Search',
  allowMultipleInstances: true,
});

export { SearchPanel };
