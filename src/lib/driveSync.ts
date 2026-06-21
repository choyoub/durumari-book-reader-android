declare global {
  interface Window {
    gapi: any;
    google: any;
  }
}

export const GOOGLE_CLIENT_ID = ""; // TODO: 발급받은 Client ID 입력
export const GOOGLE_API_KEY = "";   // TODO: 발급받은 API Key 입력
export const GOOGLE_APP_ID = "";    // TODO: 발급받은 구글 클라우드 프로젝트 번호 입력

export function loadGoogleApis(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.gapi && window.google) {
      resolve();
      return;
    }

    let loadedCount = 0;
    const checkDone = () => {
      loadedCount++;
      if (loadedCount === 2) resolve();
    };

    const script1 = document.createElement("script");
    script1.src = "https://apis.google.com/js/api.js";
    script1.onload = () => {
      window.gapi.load("picker", checkDone);
    };
    script1.onerror = reject;

    const script2 = document.createElement("script");
    script2.src = "https://accounts.google.com/gsi/client";
    script2.onload = checkDone;
    script2.onerror = reject;

    document.head.appendChild(script1);
    document.head.appendChild(script2);
  });
}

export function pickGoogleDriveFolder(): Promise<{ id: string; name: string; accessToken: string }> {
  return new Promise((resolve, reject) => {
    if (!GOOGLE_CLIENT_ID || !GOOGLE_API_KEY) {
      reject(new Error("API_KEY_MISSING"));
      return;
    }

    const tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: "https://www.googleapis.com/auth/drive.readonly",
      callback: (tokenResponse: any) => {
        if (tokenResponse.error !== undefined) {
          reject(tokenResponse);
        } else {
          showPicker(tokenResponse.access_token, resolve, reject);
        }
      },
    });

    tokenClient.requestAccessToken();
  });
}

function showPicker(accessToken: string, resolve: (val: any) => void, reject: (reason: any) => void) {
  const view = new window.google.picker.DocsView(window.google.picker.ViewId.FOLDERS)
    .setIncludeFolders(true)
    .setSelectFolderEnabled(true)
    .setMimeTypes("application/vnd.google-apps.folder");

  const picker = new window.google.picker.PickerBuilder()
    .enableFeature(window.google.picker.Feature.NAV_HIDDEN)
    .setDeveloperKey(GOOGLE_API_KEY)
    .setAppId(GOOGLE_APP_ID)
    .setOAuthToken(accessToken)
    .addView(view)
    .setTitle("도서 폴더 선택")
    .setCallback((data: any) => {
      if (data.action === window.google.picker.Action.PICKED) {
        const doc = data.docs[0];
        resolve({ id: doc.id, name: doc.name, accessToken });
      } else if (data.action === window.google.picker.Action.CANCEL) {
        reject(new Error("CANCELLED"));
      }
    })
    .build();
    
  picker.setVisible(true);
}

export async function listBooksInDriveFolder(folderId: string, accessToken: string): Promise<any[]> {
  const query = `'${folderId}' in parents and (mimeType='application/epub+zip' or mimeType='text/plain') and trashed=false`;
  const response = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name,mimeType,size)`, {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });
  if (!response.ok) throw new Error("Failed to fetch files");
  const data = await response.json();
  return data.files || [];
}
