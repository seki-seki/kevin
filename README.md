# Kevin: AI Coding Agent Bot for Slack (on Google Cloud App Engine)

This Node.js application, named Kevin, acts as a Slack bot that takes coding instructions via a slash command, uses Google Vertex AI (Gemini) to generate code changes, and creates a Pull Request on a specified GitHub repository. It runs on Google Cloud App Engine Standard Environment.

## Prerequisites

*   Node.js (Version specified in `package.json`'s `engines` field, e.g., >=20)
*   Google Cloud SDK (`gcloud` CLI) installed and configured (`gcloud init`, `gcloud auth login`)
*   A Google Cloud Project with billing enabled.
*   A GitHub Personal Access Token (PAT) with `repo` scope (or finer-grained permissions if preferred).
*   A Slack account and permission to create apps in a workspace.

## Setup Instructions

### 1. Google Cloud Project Setup

a.  **Enable APIs:** Ensure the following APIs are enabled for your Google Cloud project. You can enable them via the Cloud Console or `gcloud services enable`:
    *   **App Engine Admin API:** `appengine.googleapis.com`
    *   **Secret Manager API:** `secretmanager.googleapis.com`
    *   **Cloud Datastore API:** `datastore.googleapis.com` (Ensure Firestore is initialized in **Datastore mode** for this project, as the code uses the Datastore client library. If it's in Native mode, you'll need a different project or code modifications.)
    *   **Vertex AI API:** `aiplatform.googleapis.com`
    *   **Cloud Build API:** `cloudbuild.googleapis.com` (Usually enabled automatically when deploying to App Engine)

    ```bash
    gcloud services enable appengine.googleapis.com secretmanager.googleapis.com datastore.googleapis.com aiplatform.googleapis.com cloudbuild.googleapis.com --project YOUR_PROJECT_ID
    ```
    (Replace `YOUR_PROJECT_ID` with your actual project ID)

b.  **Create GitHub Token Secret:** Store your GitHub PAT securely in Secret Manager.
    *   Go to the Secret Manager page in the Google Cloud Console.
    *   Click "Create Secret".
    *   **Name:** `GITHUB_TOKEN` (The application code expects this exact name).
    *   **Secret value:** Paste your GitHub Personal Access Token.
    *   Leave replication policy as "Automatic".
    *   Click "Create Secret".

c.  **Grant Secret Access:** The App Engine service account needs permission to access the secret you just created.
    *   Find your App Engine default service account email. It usually looks like `YOUR_PROJECT_ID@appspot.gserviceaccount.com`. You can find it in the IAM section of the Cloud Console or by deploying the app once (it will be shown in the deployment logs).
    *   Go back to the Secret Manager page, select the `GITHUB_TOKEN` secret.
    *   Go to the "Permissions" tab.
    *   Click "Grant Access".
    *   **New principals:** Enter the App Engine service account email (`YOUR_PROJECT_ID@appspot.gserviceaccount.com`).
    *   **Assign roles:** Select the role `Secret Manager Secret Accessor`.
    *   Click "Save".

### 2. Slack App Setup

a.  **Create a Slack App:**
    *   Go to [https://api.slack.com/apps](https://api.slack.com/apps).
    *   Click "Create New App" -> "From scratch".
    *   Enter an App Name (e.g., "Kevin") and select your development workspace.
    *   Click "Create App".

b.  **Configure Slash Command:**
    *   In the app's settings page, go to "Features" > "Slash Commands".
    *   Click "Create New Command".
    *   **Command:** Enter the command users will type (e.g., `/kevin`).
    *   **Request URL:** Enter the URL of your deployed App Engine service, followed by `/slack/command`. It will look like `https://YOUR_PROJECT_ID.REGION_ID.r.appspot.com/slack/command` (e.g., `https://cline-api-456312.uc.r.appspot.com/slack/command`). You can get the base URL after the first deployment or using `gcloud app browse`.
    *   **Short Description:** A brief explanation (e.g., "Kevin AI coding agent").
    *   **Usage Hint (Optional):** Instructions for use (e.g., `[instructions] --repo=owner/repo`).
    *   Click "Save".

c.  **Install App to Workspace:**
    *   Go to "Settings" > "Install App".
    *   Click "Install to Workspace".
    *   Review the permissions and click "Allow".

### 3. Application Deployment

a.  **Clone the Repository (if necessary):**
    ```bash
    git clone <repository_url>
    cd <repository_directory>
    ```

b.  **(Optional) Install Dependencies Locally:**
    ```bash
    npm install
    ```
    (App Engine installs dependencies automatically during deployment based on `package.json`)

c.  **Deploy to App Engine:**
    Make sure you are in the project directory containing `app.yaml`, `index.js`, and `package.json`.
    Run the following command, replacing `YOUR_PROJECT_ID` if `gcloud` is not already configured for it:
    ```bash
    gcloud app deploy -q --project YOUR_PROJECT_ID
    ```
    The `-q` flag skips interactive prompts. The project ID is automatically read by the application from the `GOOGLE_CLOUD_PROJECT` environment variable provided by App Engine.

## Usage

In Slack, use the slash command you configured:

```slack
/[your-command] [Your coding instruction here] --repo=[owner/repository_name]
```

Example (using `/kevin` as the command):
`/kevin Add installation instructions to README.md --repo=my-org/my-app`

The bot (Kevin) will respond immediately with an acknowledgment. After processing (which might take some time), it will post a second message with a link to the created Pull Request or an error message.

## Notes

*   **Cold Starts:** App Engine Standard may shut down instances during periods of inactivity. The first request after inactivity might experience a delay (cold start), potentially causing a timeout message on Slack (though the background processing should still complete and post the result later).
*   **Error Handling:** Errors during AI generation or GitHub operations are caught and reported back to the Slack user who invoked the command (as an ephemeral message). Check App Engine logs for more detailed error information (`gcloud app logs tail -s default`).
*   **File Handling:** The AI is instructed to output the full content of changed files using specific delimiters (`<<<<<<< FILE: ... >>>>>>>`). The application parses this output to write changes to the correct files in the GitHub repository.
