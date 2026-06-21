# 두루마리 (Durumari) - Android Book Reader

React Native (Expo)와 WebView 기술을 기반으로 개발된 안드로이드용 텍스트 및 EPUB 전자책 리더 앱입니다.

## 주요 기능

- **다양한 포맷 지원**: EPUB, TXT, ZIP(TXT 압축) 파일을 지원합니다.
- **성능 최적화된 뷰어**: WebView를 활용하여 빠르고 가볍게 책을 렌더링합니다.
- **EPUB 지원**: `epub.js` 기반의 paginated rendition을 제공하며, 위치(CFI) 기반 복원이 가능합니다.
- **TXT/ZIP 백그라운드 처리**: Web Worker에서 파일 디코딩 및 압축 해제를 수행하여 UI 끊김을 방지합니다.
- **빠른 TXT 페이징**: 첫 페이지를 우선적으로 계산 및 렌더링하고, 나머지 페이지는 유휴 시간(idle time)에 백그라운드에서 인덱싱합니다. 화면 DOM에는 현재 페이지만 유지하여 메모리 사용량을 최소화합니다.
- **로컬 저장소 활용**: 사용자의 읽기 위치와 앱 설정이 로컬 기기에 안전하게 저장됩니다.

## 프로젝트 구조

이 프로젝트는 크게 두 부분으로 나뉘어 있습니다:
1. **웹 뷰어 영역 (Root)**: React와 Vite로 빌드되며, 실제 책을 렌더링하고 페이징하는 핵심 로직이 들어있습니다.
2. **모바일 앱 영역 (`/mobile`)**: Expo (React Native) 기반으로 구성되어 있으며, 안드로이드 기기의 파일 시스템 접근 및 웹 뷰어를 감싸는 네이티브 컨테이너 역할을 합니다.

## 설치 및 실행 방법

### 1. 웹 뷰어 빌드 (필수)
먼저 모바일 앱의 WebView에서 사용할 웹 번들을 빌드해야 합니다.

```bash
# 의존성 설치
npm install

# 웹 번들 빌드
npm run build
```

### 2. 안드로이드 앱 실행
웹 빌드가 완료되면 `mobile` 폴더에서 Expo 앱을 실행할 수 있습니다.

```bash
cd mobile

# 의존성 설치
npm install

# 개발 서버 실행
npx expo start

# 또는 안드로이드 기기/에뮬레이터에서 바로 실행
npx expo run:android
```

## APK 빌드 생성

안드로이드용 APK를 빌드하려면 Expo EAS Build를 사용하거나 로컬에서 빌드할 수 있습니다.

```bash
cd mobile
npx expo run:android --variant release
```
