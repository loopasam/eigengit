# Self-Writing Coding Agent

A self-writing coding agent built with TypeScript that can modify its own codebase based on GitHub issues. This agent uses Claude AI to understand requirements and automatically generate code changes.

## How It Works

1. **Issue Detection**: When a GitHub issue is labeled with "agent", the GitHub Actions workflow triggers automatically
2. **Context Gathering**: The agent reads the issue description and gathers the current codebase
3. **AI Processing**: It sends the issue + codebase to Claude AI for analysis and code generation
4. **Code Generation**: Claude generates the necessary file changes to address the issue
5. **PR Creation**: The agent creates a new branch, applies the changes, and opens a pull request
6. **Review**: The generated PR can be reviewed and merged like any normal pull request

## Setup

### Prerequisites
- A GitHub repository with this codebase
- Anthropic API key for Claude AI access
- GitHub Personal Access Token with repository permissions

### Required Secrets
Add these secrets to your GitHub repository:

- `ANTHROPIC_API_KEY`: Your Anthropic API key
- `AGENT_GH_TOKEN`: GitHub Personal Access Token with repo permissions

### Installation
1. Clone this repository
2. Install dependencies: `npm install`
3. Add the required secrets to your GitHub repository settings
4. Create an issue and add the "agent" label to trigger the workflow

## Usage

1. Create a GitHub issue describing what you want the agent to do
2. Add the "agent" label to the issue
3. The GitHub Actions workflow will automatically trigger
4. Wait for the agent to analyze the issue and create a PR
5. Review the generated PR and merge if satisfactory

## Project Structure

- `agent.ts` - Main agent logic that processes issues and generates code
- `.github/workflows/agent.yml` - GitHub Actions workflow configuration
- `package.json` - Node.js dependencies and scripts
- `tsconfig.json` - TypeScript configuration

## Features

- **Self-modifying**: Can modify its own codebase based on natural language descriptions
- **GitHub Integration**: Seamlessly integrates with GitHub issues and pull requests  
- **AI-Powered**: Uses Claude AI for intelligent code generation
- **TypeScript**: Built with modern TypeScript and ESM modules
- **Automated Workflow**: Fully automated via GitHub Actions

## Limitations

- Requires careful review of generated code before merging
- Limited by the capabilities and context window of the underlying AI model
- Best suited for well-defined, specific coding tasks
- May require iteration for complex changes

## Contributing

Since this is a self-writing agent, you can contribute by:
1. Creating issues with clear descriptions of desired features or fixes
2. Adding the "agent" label to trigger automatic code generation
3. Reviewing and providing feedback on generated pull requests

## License

This project is open source and available under the MIT License.