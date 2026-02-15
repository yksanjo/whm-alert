#!/usr/bin/env node

/**
 * WHM Alert - CI/CD Pipeline Alerting System
 * Sends alerts when pipeline failures or issues are detected
 */

import axios from 'axios';
import { Command } from 'commander';
import chalk from 'chalk';

const program = new Command();

interface AlertConfig {
  platform: string;
  token: string;
  owner: string;
  repo: string;
  channels: string[];
  webhookUrl?: string;
  slackWebhook?: string;
  checkInterval?: number;
  watch?: boolean;
}

program
  .name('whm-alert')
  .description('CI/CD pipeline alerting system')
  .version('1.0.0');

program
  .requiredOption('-p, --platform <platform>', 'CI/CD platform (github, gitlab)')
  .requiredOption('-t, --token <token>', 'API token')
  .requiredOption('-o, --owner <owner>', 'Repository owner')
  .requiredOption('-r, --repo <repo>', 'Repository name')
  .option('-w, --webhook <url>', 'Generic webhook URL for alerts')
  .option('-s, --slack <url>', 'Slack webhook URL')
  .option('-i, --interval <seconds>', 'Check interval in seconds', '60')
  .option('--watch', 'Enable continuous monitoring')
  .action(async (options) => {
    const config: AlertConfig = {
      platform: options.platform,
      token: options.token,
      owner: options.owner,
      repo: options.repo,
      channels: [],
      webhookUrl: options.webhook,
      slackWebhook: options.slack,
      checkInterval: parseInt(options.interval, 10) * 1000,
      watch: options.watch,
    };

    if (!config.webhookUrl && !config.slackWebhook) {
      console.error(chalk.red('Error: Please specify at least one webhook URL (--webhook or --slack)'));
      process.exit(1);
    }

    console.log(chalk.cyan('🔔 WHM Alert - CI/CD Pipeline Monitor'));
    console.log(chalk.gray(`Monitoring: ${config.owner}/${config.repo}`));
    console.log(chalk.gray(`Interval: ${options.interval}s\n`));

    let lastRunId: string | null = null;

    const checkPipeline = async () => {
      try {
        let latestRun: any = null;

        if (config.platform === 'github') {
          const response = await axios.get(
            `https://api.github.com/repos/${config.owner}/${config.repo}/actions/runs`,
            {
              headers: {
                'Authorization': `Bearer ${config.token}`,
                'Accept': 'application/vnd.github+json',
              },
              params: { per_page: 1 },
            }
          );
          latestRun = response.data.workflow_runs?.[0];
        } else if (config.platform === 'gitlab') {
          const projectId = encodeURIComponent(`${config.owner}/${config.repo}`);
          const response = await axios.get(
            `https://gitlab.com/api/v4/projects/${projectId}/pipelines`,
            {
              headers: { 'PRIVATE-TOKEN': config.token },
              params: { per_page: 1 },
            }
          );
          latestRun = response.data?.[0];
        }

        if (!latestRun) return;

        const runId = String(latestRun.id);
        const status = config.platform === 'github' ? latestRun.conclusion : latestRun.status;
        
        // Check for new failure
        if (lastRunId && runId !== lastRunId) {
          if (status === 'failure' || status === 'failed') {
            await sendAlert(config, latestRun, 'failure');
          } else if (status === 'success' || status === 'success') {
            await sendAlert(config, latestRun, 'recovery');
          }
        }

        // First run - just store the ID
        if (!lastRunId) {
          lastRunId = runId;
          const statusText = status === 'success' ? chalk.green('✓ PASS') : 
                           status === 'failure' ? chalk.red('✗ FAIL') : chalk.yellow('⟳ RUNNING');
          console.log(`${chalk.gray(new Date().toISOString())} ${statusText}`);
        }

      } catch (error) {
        console.error(chalk.red('Error checking pipeline:'), error instanceof Error ? error.message : error);
      }
    };

    // Initial check
    await checkPipeline();

    if (config.watch) {
      console.log(chalk.gray('Watching for changes... (Ctrl+C to stop)\n'));
      setInterval(checkPipeline, config.checkInterval);
    }
  });

program.parse();

async function sendAlert(config: AlertConfig, run: any, type: 'failure' | 'recovery') {
  const repoName = `${config.owner}/${config.repo}`;
  const message = type === 'failure' 
    ? `🚨 Pipeline Failed: ${repoName}`
    : `✅ Pipeline Recovered: ${repoName}`;
  
  const details = type === 'failure'
    ? `The pipeline has failed. Check the logs for more details.`
    : `The pipeline is now passing again.`;

  const payload = {
    text: message,
    attachments: [{
      color: type === 'failure' ? '#ff0000' : '#00ff00',
      fields: [
        { title: 'Repository', value: repoName, short: true },
        { title: 'Status', value: type === 'failure' ? 'FAILED' : 'PASSED', short: true },
        { title: 'Details', value: details },
      ],
    }],
  };

  // Send to Slack
  if (config.slackWebhook) {
    try {
      await axios.post(config.slackWebhook, payload);
      console.log(chalk.yellow(`Alert sent to Slack: ${type}`));
    } catch (error) {
      console.error(chalk.red('Failed to send Slack alert:'), error);
    }
  }

  // Send to generic webhook
  if (config.webhookUrl) {
    try {
      await axios.post(config.webhookUrl, {
        event: type,
        repository: repoName,
        timestamp: new Date().toISOString(),
        run,
      });
      console.log(chalk.yellow(`Alert sent to webhook: ${type}`));
    } catch (error) {
      console.error(chalk.red('Failed to send webhook alert:'), error);
    }
  }
}
