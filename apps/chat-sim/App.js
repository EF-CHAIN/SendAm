import './global.css';
import { StatusBar } from 'expo-status-bar';
import { Text, View } from 'react-native';

export default function App() {
  return (
    <View className="flex-1 items-center justify-center bg-white">
      <Text className="text-base text-gray-800">SendAm chat simulator — NativeWind is working.</Text>
      <StatusBar style="auto" />
    </View>
  );
}
