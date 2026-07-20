import './global.css';
import { StatusBar } from 'expo-status-bar';
import ChatScreen from './src/ChatScreen';

export default function App() {
  return (
    <>
      <ChatScreen />
      <StatusBar style="auto" />
    </>
  );
}
