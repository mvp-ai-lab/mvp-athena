import {
  ChatInputCommandInteraction,
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder
} from "discord.js";
import { AthenaApiClient } from "./api-client.js";

const token = process.env.DISCORD_TOKEN;
const applicationId = process.env.DISCORD_APPLICATION_ID;
const client = new AthenaApiClient();

const commands = [
  new SlashCommandBuilder().setName("athena-spaces").setDescription("List accessible knowledge spaces"),
  new SlashCommandBuilder()
    .setName("athena-search")
    .setDescription("Search team knowledge")
    .addStringOption((option) => option.setName("query").setDescription("Search query").setRequired(true))
    .addStringOption((option) => option.setName("space").setDescription("Optional space id")),
  new SlashCommandBuilder()
    .setName("athena-read")
    .setDescription("Read a knowledge document")
    .addStringOption((option) => option.setName("space").setDescription("Space id").setRequired(true))
    .addStringOption((option) => option.setName("path").setDescription("Document path").setRequired(true))
].map((command) => command.toJSON());

async function replyJson(interaction: ChatInputCommandInteraction, value: unknown): Promise<void> {
  const text = JSON.stringify(value, null, 2);
  await interaction.editReply(text.length > 1900 ? `${text.slice(0, 1890)}\n...` : text);
}

async function handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  if (interaction.commandName === "athena-spaces") {
    await replyJson(interaction, await client.request("GET", "/spaces"));
    return;
  }

  if (interaction.commandName === "athena-search") {
    const query = interaction.options.getString("query", true);
    const space = interaction.options.getString("space");
    const path = space
      ? `/spaces/${encodeURIComponent(space)}/search?q=${encodeURIComponent(query)}`
      : `/search?q=${encodeURIComponent(query)}`;
    await replyJson(interaction, await client.request("GET", path));
    return;
  }

  if (interaction.commandName === "athena-read") {
    const space = interaction.options.getString("space", true);
    const path = interaction.options.getString("path", true);
    await replyJson(interaction, await client.request("GET", `/spaces/${encodeURIComponent(space)}/docs/${path}`));
  }
}

if (!token || !applicationId) {
  throw new Error("DISCORD_TOKEN and DISCORD_APPLICATION_ID are required");
}

const rest = new REST({ version: "10" }).setToken(token);
await rest.put(Routes.applicationCommands(applicationId), { body: commands });

const discord = new Client({ intents: [GatewayIntentBits.Guilds] });
discord.on("interactionCreate", (interaction) => {
  if (!interaction.isChatInputCommand()) {
    return;
  }
  handleCommand(interaction).catch(async (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(`Error: ${message}`);
    } else {
      await interaction.reply({ content: `Error: ${message}`, ephemeral: true });
    }
  });
});

await discord.login(token);
