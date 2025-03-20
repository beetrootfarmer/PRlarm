// pr-reminder.js
const fs = require("fs");
const core = require("@actions/core");
const github = require("@actions/github");

// 공휴일 확인 함수
function isHoliday(date) {
  // 한국 공휴일 목록 (2025년 기준)
  const holidays = [
    "2025-01-01", // 신정
    "2025-01-28", // 설날
    "2025-01-29", // 설날
    "2025-01-30", // 설날
    "2025-03-01", // 삼일절
    "2025-05-05", // 어린이날
    "2025-05-08", // 부처님오신날
    "2025-06-06", // 현충일
    "2025-08-15", // 광복절
    "2025-09-16", // 추석
    "2025-09-17", // 추석
    "2025-09-18", // 추석
    "2025-10-03", // 개천절
    "2025-10-09", // 한글날
    "2025-12-25", // 크리스마스
  ];

  const formattedDate = date.toISOString().split("T")[0];
  return holidays.includes(formattedDate);
}

// 사용자 매핑 파일 로드
function loadUserMapping() {
  let userMapping = {};
  try {
    if (fs.existsSync(".github/workflows/user-mapping.json")) {
      const mappingData = fs.readFileSync(
        ".github/workflows/user-mapping.json",
        "utf8"
      );
      userMapping = JSON.parse(mappingData).github_to_slack || {};
    }
  } catch (error) {
    console.log("사용자 매핑 파일을 로드하는 중 오류 발생:", error);
  }
  return userMapping;
}

// GitHub 사용자명을 Slack ID로 변환하는 함수
function getSlackId(githubUsername, userMapping) {
  return userMapping[githubUsername]
    ? `<@${userMapping[githubUsername]}>`
    : githubUsername;
}

// 지라 티켓 ID 추출 함수
function extractJiraTicket(pr) {
  if (!pr.body) return null;

  // "Related issue" 섹션 찾기 시도
  const relatedIssueRegex =
    /(?:related|linked|connected)\s+(?:issue|issues|ticket|tickets)[^\n]*\n([\s\S]*?)(?:\n\s*\n|\n*$)/i;
  const relatedSection = pr.body.match(relatedIssueRegex);

  let searchText =
    relatedSection && relatedSection[1] ? relatedSection[1] : pr.body;

  // genesisnest.atlassian.net 도메인을 포함한 링크 찾기
  const jiraLinkRegex =
    /https?:\/\/genesisnest\.atlassian\.net\/browse\/([A-Z]+-\d+)/g;
  const allMatches = [...searchText.matchAll(jiraLinkRegex)];

  if (allMatches.length > 0) {
    // 첫 번째 매치의 티켓 ID 반환
    return allMatches[0][1];
  }

  // 백업: 본문 전체에서 Jira 티켓 ID 패턴 찾기
  const jiraTicketRegex = /([A-Z]+-\d+)/g;
  const matches = pr.body.match(jiraTicketRegex);

  // 본문에서 찾지 못하면 제목에서 시도
  if (!matches) {
    const titleMatches = pr.title.match(jiraTicketRegex);
    return titleMatches ? titleMatches[0] : null;
  }

  return matches[0];
}

// 리뷰어 상태 확인 함수
function checkReviewStatus(pr, reviews) {
  // 리뷰어별 최신 리뷰 상태 확인
  const reviewerStatus = {};
  reviews.forEach((review) => {
    // 각 리뷰어의 가장 최신 리뷰 상태만 저장
    if (
      !reviewerStatus[review.user.login] ||
      new Date(reviewerStatus[review.user.login].submitted_at) <
        new Date(review.submitted_at)
    ) {
      reviewerStatus[review.user.login] = review;
    }
  });

  // 현재 요청된 리뷰어 목록
  const currentRequestedReviewers = pr.requested_reviewers.map((r) => r.login);

  // 승인 여부 확인 (모든 현재 요청된 리뷰어가 아직 승인하지 않았거나, 승인 후 새 커밋이 있는 경우)
  let needsReview = false;

  // 현재 요청된 각 리뷰어에 대해 확인
  for (const reviewer of currentRequestedReviewers) {
    // 리뷰어가 아직 리뷰하지 않았거나, 최신 리뷰가 승인이 아닌 경우
    if (
      !reviewerStatus[reviewer] ||
      reviewerStatus[reviewer].state !== "APPROVED"
    ) {
      needsReview = true;
      break;
    }

    // 승인했지만 그 이후에 새 커밋이 추가된 경우
    const approvalDate = new Date(reviewerStatus[reviewer].submitted_at);
    const lastCommitDate = new Date(
      pr.head.sha.committed_date || pr.updated_at
    );

    if (approvalDate < lastCommitDate) {
      needsReview = true;
      break;
    }
  }

  return needsReview;
}

// PR 메시지 생성 함수
function createPRMessage(pr, reviewers, jiraTicket, daysOld, assignees) {
  let message = "";
  let jiraInfo = "";

  if (jiraTicket) {
    jiraInfo = ` | 지라: <https://genesisnest.atlassian.net/browse/${jiraTicket}|${jiraTicket}>`;
  }

  let urgencyEmoji = "";
  if (daysOld >= 3) {
    urgencyEmoji = "🍂"; // 3일 이상 지난 PR
  } else if (daysOld >= 1) {
    urgencyEmoji = "🍃"; // 1-2일 지난 PR
  } else {
    urgencyEmoji = "🌱"; // 오늘 생성된 PR
  }

  message += `${urgencyEmoji} <${pr.html_url}|#${pr.number}: ${pr.title}>${jiraInfo}\n`;
  message += `   • 리뷰어: ${reviewers}\n`;
  message += `   • 담당자: ${assignees}\n`;
  message += `   • 요청일: ${new Date(pr.created_at).toLocaleDateString(
    "ko-KR"
  )} (${daysOld === 0 ? "오늘" : `${daysOld}일 전`})\n\n`;

  return message;
}

// 메인 함수
async function run() {
  try {
    // 오늘이 공휴일인지 확인
    const today = new Date();
    if (isHoliday(today)) {
      console.log("오늘은 공휴일입니다. PR 알림을 건너뜁니다.");
      return;
    }

    const token = core.getInput("github-token");
    const octokit = github.getOctokit(token);
    const context = github.context;

    // 사용자 매핑 로드
    const userMapping = loadUserMapping();

    // PR 목록 가져오기
    const prs = await octokit.rest.pulls.list({
      owner: context.repo.owner,
      repo: context.repo.repo,
      state: "open",
    });

    let message = "📋 *리뷰 대기 중인 PR 목록*\n\n";
    let hasPRs = false;

    for (const pr of prs.data) {
      // 리뷰 상태 확인
      const reviews = await octokit.rest.pulls.listReviews({
        owner: context.repo.owner,
        repo: context.repo.repo,
        pull_number: pr.number,
      });

      // 리뷰가 필요한지 확인
      const needsReview = checkReviewStatus(pr, reviews.data);

      // 리뷰가 필요하지 않으면 건너뛰기
      if (!needsReview) continue;

      if (pr.requested_reviewers && pr.requested_reviewers.length > 0) {
        hasPRs = true;

        // 리뷰어 정보 가져오기 (Slack ID로 변환)
        const reviewers = pr.requested_reviewers
          .map((r) => {
            if (r.login) {
              return getSlackId(r.login, userMapping);
            } else if (r.slug) {
              return `팀: ${r.slug}`;
            } else {
              return "알 수 없는 리뷰어";
            }
          })
          .join(", ");

        // 지라 티켓 정보 추출
        const jiraTicket = extractJiraTicket(pr);

        // PR 생성일로부터 경과일 계산
        const createdDate = new Date(pr.created_at);
        const daysOld = Math.floor(
          (today - createdDate) / (1000 * 60 * 60 * 24)
        );

        // 담당자 정보 추가
        const assignees =
          pr.assignees && pr.assignees.length > 0
            ? pr.assignees
                .map((a) => getSlackId(a.login, userMapping))
                .join(", ")
            : "없음";

        // PR 메시지 생성 및 추가
        message += createPRMessage(
          pr,
          reviewers,
          jiraTicket,
          daysOld,
          assignees
        );
      }
    }

    if (!hasPRs) {
      message = "🙌 *현재 리뷰 대기 중인 PR이 없습니다.* 🎉";
    }

    // 결과 출력
    core.setOutput("message", message);
    core.setOutput("has_prs", hasPRs.toString());

    // 디버깅을 위해 콘솔에 출력
    console.log(message);
  } catch (error) {
    core.setFailed(`Action failed with error: ${error}`);
  }
}

// 실행
run();
