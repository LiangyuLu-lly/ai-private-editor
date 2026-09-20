const REVIEW_PROGRESS_ID = "privacy-composer-review-progress";
const REVIEW_PROGRESS_TEXT = "正在本地复核…";

export function showReviewProgress(document: Document): void {
  const body = document.body;
  if (body === null) {
    return;
  }

  if (document.getElementById(REVIEW_PROGRESS_ID) !== null) {
    return;
  }

  const status = document.createElement("div");
  status.id = REVIEW_PROGRESS_ID;
  status.className = "privacy-composer-toast";
  status.setAttribute("role", "status");
  status.dataset.state = "warning";
  status.textContent = REVIEW_PROGRESS_TEXT;
  body.append(status);
}

export function hideReviewProgress(document: Document): void {
  document.getElementById(REVIEW_PROGRESS_ID)?.remove();
}
