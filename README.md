# 두루마리 WebView

기존 WPF 앱과 분리된 Tauri 2 + WebView2 기반 리더입니다.

## 실행

```powershell
npm install
npm run dev
```

Windows 앱으로 실행하려면 Rust와 Microsoft C++ Build Tools 설치 후:

```powershell
npm run tauri dev
```

설치 파일 생성:

```powershell
npm run tauri build
```

## 성능 구조

- EPUB: epub.js paginated rendition, 위치(CFI) 기반 복원
- TXT/ZIP: Web Worker에서 디코딩·압축 해제
- TXT 페이징: 첫 페이지 우선 계산, 나머지는 idle time에 인덱싱
- 화면 DOM에는 현재 TXT 페이지만 유지
- 읽기 위치와 설정은 로컬 저장
