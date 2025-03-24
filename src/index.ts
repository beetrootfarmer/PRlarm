import { Probot } from "probot";
import { WebClient } from "@slack/web-api";

const slackClient = new WebClient(process.env.SLACK_BOT_TOKEN);
const slackChannel = process.env.SLACK_CHANNEL_ID || "";

export default (app: Probot) => {
  app.log.info("PRlarm is running! 🚀");

  // check up slack env
  const isSlackConfigured =
    !!process.env.SLACK_BOT_TOKEN && !!process.env.SLACK_CHANNEL_ID;
  if (!isSlackConfigured) {
    app.log.warn("SLACK_BOT_TOKEN or SLACK_CHANNEL_ID is not configured");
  } else {
    app.log.info("SLACK_BOT_TOKEN and SLACK_CHANNEL_ID are configured");
  }

  // PR review requested
  app.on("pull_request.review_requested", async (context) => {
    const pr = context.payload.pull_request;
    const repo = context.payload.repository;

    app.log.info(
      "Requested Reviewers:",
      JSON.stringify(context.payload.pull_request, null, 2)
    );

    console.log(JSON.stringify(context.payload.pull_request, null, 2));

    // 리뷰어 정보 추출 (타입 가드 사용)
    let reviewerInfo = "리뷰어 없음";
    const reviewers = context.payload.pull_request.requested_reviewers;

    if (reviewers && reviewers.length > 0) {
      const reviewer = reviewers[0];
      // User 타입인지 확인 (login 속성이 있는지 확인)
      if ("login" in reviewer) {
        reviewerInfo = reviewer.login;
      } else if ("slug" in reviewer) {
        // Team 타입인 경우
        reviewerInfo = `팀: ${
          reviewer.slug || reviewer.name || "알 수 없는 팀"
        }`;
      }
    }

    app.log.info(`PR #${pr.number}에 리뷰어가 추가되었습니다: ${reviewerInfo}`);
    await sendSlackNotification({
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*PR 리뷰 요청* 👀\n*저장소:* ${repo.full_name}`,
          },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*<${pr.html_url}|${pr.title}>*\n리뷰어: ${reviewerInfo}`,
          },
        },
      ],
      text: `PR 리뷰 요청: ${pr.title}`, // 알림이 꺼져 있을 때 표시되는 텍스트
    });
  });
  // Slack 알림 전송 함수
  async function sendSlackNotification(message: any) {
    if (!isSlackConfigured) {
      app.log.info("Slack 정보가 설정되지 않아 알림을 건너뜁니다.");
      return;
    }

    try {
      await slackClient.chat.postMessage({
        channel: slackChannel,
        ...message,
      });

      app.log.info("Slack 알림이 전송되었습니다");
    } catch (error) {
      app.log.error(`Slack 알림 전송 오류: ${error}`);
    }
  }
};
