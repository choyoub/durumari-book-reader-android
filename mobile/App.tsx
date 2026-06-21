import React, { useEffect, useRef, useState } from 'react';
import { Alert, BackHandler, StyleSheet } from 'react-native';
import { Directory as ExpoDirectory, File as ExpoFile } from 'expo-file-system';
import * as FileSystem from 'expo-file-system/legacy';
import { StatusBar } from 'expo-status-bar';
import { WebView } from 'react-native-webview';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

const { StorageAccessFramework } = FileSystem;

type NativeFile = {
  name: string;
  size: number;
  uri: string;
  lastModified: number;
};

const BASE64_CHUNK_SIZE = 256 * 1024;

function safeDecode(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function documentName(uri: string) {
  const decoded = safeDecode(uri);
  const documentMarker = '/document/';
  const documentId = decoded.includes(documentMarker)
    ? decoded.slice(decoded.lastIndexOf(documentMarker) + documentMarker.length)
    : decoded;
  return documentId.split('/').filter(Boolean).pop() || '이름 없는 파일';
}

function directoryDisplayInfo(uri: string) {
  const decoded = safeDecode(uri);
  const treeMarker = '/tree/';
  const treeId = decoded.includes(treeMarker)
    ? decoded.slice(decoded.lastIndexOf(treeMarker) + treeMarker.length).split('/document/')[0]
    : decoded;
  const separator = treeId.indexOf(':');
  const volume = separator >= 0 ? treeId.slice(0, separator) : '';
  const relativePath = separator >= 0 ? treeId.slice(separator + 1) : treeId;
  const parts = relativePath.split('/').filter(Boolean);
  const rootName = volume.toLowerCase() === 'primary'
    ? '내부 저장소'
    : volume.toLowerCase() === 'home'
      ? '문서'
      : volume
        ? `SD 카드 (${volume})`
        : '선택한 폴더';

  return {
    path: [rootName, ...parts].join('/'),
    name: parts.at(-1) || rootName,
  };
}

async function readBooksRecursively(directoryUri: string): Promise<NativeFile[]> {
  const children = new ExpoDirectory(directoryUri).list();
  const files: NativeFile[] = [];

  for (const child of children) {
    if (child instanceof ExpoDirectory) {
      files.push(...await readBooksRecursively(child.uri));
      continue;
    }

    const name = documentName(child.uri);
    if (!/\.(epub|txt|zip)$/i.test(name)) continue;
    const info = child.info();
    if (!info.exists) continue;
    files.push({
      name,
      size: info.size || child.size || 0,
      uri: child.uri,
      lastModified: info.creationTime || info.modificationTime || child.lastModified || Date.now(),
    });
  }

  return files;
}

export default function App() {
  const webviewRef = useRef<WebView>(null);
  const [statusBarStyle, setStatusBarStyle] = useState<'auto' | 'light' | 'dark'>('auto');
  const [systemBarColor, setSystemBarColor] = useState('#cfbe90');
  const ASSET_URL = 'file:///android_asset/dist/index.html';

  useEffect(() => {
    const onBackPress = () => {
      webviewRef.current?.injectJavaScript(`
        var evt = new Event('hardwareBackPress', { cancelable: true });
        window.dispatchEvent(evt);
        if (!evt.defaultPrevented) {
          window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'BACK_EXIT' }));
        }
        true;
      `);
      return true;
    };

    const subscription = BackHandler.addEventListener('hardwareBackPress', onBackPress);
    return () => subscription.remove();
  }, []);

  const sendToWeb = (message: unknown) => {
    const eventData = JSON.stringify(JSON.stringify(message));
    webviewRef.current?.injectJavaScript(`
      window.dispatchEvent(new MessageEvent('message', { data: ${eventData} }));
      true;
    `);
  };

  const onMessage = async (event: any) => {
    let data: any;
    try {
      data = JSON.parse(event.nativeEvent.data);

      if (data.type === 'SELECT_FOLDER') {
        try {
          const permissions = await StorageAccessFramework.requestDirectoryPermissionsAsync();
          if (!permissions.granted) {
            sendToWeb({ type: 'SELECT_FOLDER_RESULT', requestId: data.requestId, payload: null });
            return;
          }

          const directoryUri = permissions.directoryUri;
          const display = directoryDisplayInfo(directoryUri);
          sendToWeb({
            type: 'SELECT_FOLDER_RESULT',
            requestId: data.requestId,
            payload: {
              ...display,
              handle: { kind: 'android-saf-directory', directoryUri },
            },
          });
        } catch (pickerError: any) {
          Alert.alert('폴더 선택 오류', pickerError?.message || String(pickerError));
          sendToWeb({
            type: 'SELECT_FOLDER_RESULT',
            requestId: data.requestId,
            payload: null,
            error: pickerError?.message || String(pickerError),
          });
        }
      } else if (data.type === 'SCAN_FOLDER') {
        try {
          const files = await readBooksRecursively(data.directoryUri);
          sendToWeb({ type: 'SCAN_FOLDER_RESULT', requestId: data.requestId, files });
        } catch (scanError: any) {
          sendToWeb({
            type: 'SCAN_FOLDER_RESULT',
            requestId: data.requestId,
            files: null,
            error: scanError?.message || String(scanError),
          });
        }
      } else if (data.type === 'READ_FILE') {
        const file = new ExpoFile(data.uri);
        const base64 = await file.base64();
        const chunkCount = Math.ceil(base64.length / BASE64_CHUNK_SIZE);
        sendToWeb({ type: 'READ_FILE_START', requestId: data.requestId, uri: data.uri, size: file.size || 0, chunkCount });
        for (let index = 0; index < chunkCount; index += 1) {
          sendToWeb({
            type: 'READ_FILE_CHUNK',
            requestId: data.requestId,
            index,
            base64: base64.slice(index * BASE64_CHUNK_SIZE, (index + 1) * BASE64_CHUNK_SIZE),
          });
          if (index % 8 === 7) await new Promise(resolve => setTimeout(resolve, 0));
        }
        sendToWeb({ type: 'READ_FILE_RESULT', requestId: data.requestId, uri: data.uri, chunkCount });
      } else if (data.type === 'BACK_EXIT') {
        BackHandler.exitApp();
      } else if (data.type === 'WEB_ERROR') {
        Alert.alert('도서 뷰어 오류', data.message || '알 수 없는 오류가 발생했습니다.');
      } else if (data.type === 'THEME_CHANGED') {
        setStatusBarStyle(data.theme === 'dark' ? 'light' : data.theme === 'system' ? 'auto' : 'dark');
        if (typeof data.backgroundColor === 'string') setSystemBarColor(data.backgroundColor);
      }
    } catch (error: any) {
      console.error('Bridge error:', error);
      Alert.alert('앱 연결 오류', error?.message || String(error));
      if (data?.requestId) {
        sendToWeb({
          type: `${data.type}_RESULT`,
          requestId: data.requestId,
          error: error?.message || String(error),
        });
      }
    }
  };

  return (
    <SafeAreaProvider>
      <StatusBar hidden={false} style={statusBarStyle} />
      <SafeAreaView style={[styles.container, { backgroundColor: systemBarColor }]} edges={['top', 'right', 'bottom', 'left']}>
        <WebView
          ref={webviewRef}
          source={{ uri: ASSET_URL }}
          onMessage={onMessage}
          javaScriptEnabled
          domStorageEnabled
          allowFileAccess
          allowUniversalAccessFromFileURLs
          originWhitelist={['*']}
          bounces={false}
          overScrollMode="never"
          showsVerticalScrollIndicator={false}
          showsHorizontalScrollIndicator={false}
          textZoom={100}
        />
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#cfbe90',
  },
});
