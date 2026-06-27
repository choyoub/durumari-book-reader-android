# 두루마리 (Durumari) - Android Book Reader

<p align="center">
  <img src="./assets/screenshot.jpg" alt="Durumari Screenshot" width="300" />
</p>

React Native (Expo)와 WebView 기술을 기반으로 개발된 안드로이드용 텍스트 및 EPUB 전자책 리더 앱입니다.

## 주요 기능

- **다양한 포맷 지원**: EPUB, TXT, ZIP(TXT 압축) 파일을 지원합니다.
- **성능 최적화된 뷰어**: WebView를 활용하여 빠르고 가볍게 책을 렌더링합니다.
- **EPUB 지원**: `epub.js` 기반의 paginated rendition을 제공하며, 위치(CFI) 기반 복원이 가능합니다.
- **TXT/ZIP 백그라운드 처리**: Web Worker에서 파일 디코딩 및 압축 해제를 수행하여 UI 끊김을 방지합니다.
- **빠른 TXT 페이징**: 첫 페이지를 우선적으로 계산 및 렌더링하고, 나머지 페이지는 유휴 시간(idle time)에 백그라운드에서 인덱싱합니다. 화면 DOM에는 현재 페이지만 유지하여 메모리 사용량을 최소화합니다.
- **로컬 저장소 활용**: 사용자의 읽기 위치와 앱 설정이 로컬 기기에 안전하게 저장됩니다.

## ⚙️ 사용자 설정 (Settings)

앱 내 설정 메뉴를 통해 사용자 맞춤형 독서 환경을 구성할 수 있습니다:
- **뷰어 테마**: 라이트 / 다크 모드 및 배경 색상 테마 변경
- **텍스트 스타일**: 다양한 폰트 선택, 글자 크기 및 줄 간격 조절
- **레이아웃**: 화면 여백(상하좌우) 세부 조절 및 텍스트 정렬 방식 선택
- **조작 및 편의성**: 화면 여백 터치를 통한 페이지 이동 및 제스처 지원

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

## APK 빌드 생성 (Production)

루트 `package.json`에 릴리즈 APK 빌드 스크립트가 등록되어 있습니다. Windows PowerShell 환경에서는 아래 명령 하나로 웹뷰 번들 빌드, Android 에셋 복사, Gradle 릴리즈 APK 생성까지 한 번에 처리할 수 있습니다.

```bash
npm run build:apk
```

이 스크립트는 내부적으로 다음 작업을 수행합니다.

1. `npm run build`로 웹뷰어 프로덕션 번들을 생성합니다.
2. `dist` 결과물을 `mobile/android/app/src/main/assets/dist`로 복사합니다.
3. `NODE_ENV=production`을 설정하고 `:app:assembleRelease`를 실행합니다.
4. 생성된 APK 경로, 파일 크기, SHA256 해시를 출력합니다.

완성된 APK 파일은 다음 경로에 생성됩니다.

`mobile\android\app\build\outputs\apk\release\app-release.apk`

참고:
- 현재 `release` 빌드는 `mobile/android/app/build.gradle` 설정상 debug keystore로 서명됩니다.
- 빌드 중 네이티브 캐시 문제(`.cxx` 에러 등)가 발생하면 `mobile\android\app\.cxx` 폴더를 삭제한 뒤 다시 `npm run build:apk`를 실행하세요.
- 아래 수동 절차는 `build:apk`가 수행하는 작업을 직접 실행해야 할 때만 참고하면 됩니다.

안드로이드용 릴리즈 APK를 로컬에서 완전히 수동으로 빌드하려면 웹앱을 먼저 빌드하고, 그 결과물을 모바일 에셋 폴더로 복사한 뒤 Gradle 빌드를 수행해야 합니다. 

아래 명령어는 Windows PowerShell 환경을 기준으로 모든 과정을 한 번에 수행하는 명령어입니다.

```powershell
# 1. 환경 변수 안전장치 (선택 사항이지만 권장)
$env:NODE_ENV='production'

# 2. 웹 뷰어 프로덕션 빌드
npm run build

# 3. 빌드된 웹 번들을 안드로이드 에셋(assets) 폴더로 복사
Copy-Item -Path ".\dist\*" -Destination ".\mobile\android\app\src\main\assets\dist" -Recurse -Force

# 4. 안드로이드 빌드 환경 변수 확인 (필요시 자신의 환경에 맞게 수정)
$env:JAVA_HOME="C:\Program Files\Android\Android Studio\jbr"
$env:ANDROID_HOME="C:\Users\자신의윈도우계정명\AppData\Local\Android\Sdk"

# 5. 최종 릴리즈 APK 빌드
.\mobile\android\gradlew.bat -p .\mobile\android :app:assembleRelease
```

> **참고**: 빌드 중 네이티브 캐시 문제(`.cxx` 에러 등)가 발생할 경우 `.\mobile\android\app\.cxx` 폴더를 수동으로 삭제한 뒤 다시 시도하시면 됩니다.

완성된 APK 파일은 다음 경로에 생성됩니다:
`mobile\android\app\build\outputs\apk\release\app-release.apk`
