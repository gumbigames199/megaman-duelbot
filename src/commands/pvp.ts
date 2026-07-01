// src/commands/pvp.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  ButtonInteraction,
  StringSelectMenuInteraction,
} from 'discord.js';

import {
  createPvpChallenge,
  handlePvpButton,
  handlePvpSelect,
} from '../lib/pvp';

export const data = new SlashCommandBuilder()
  .setName('pvp')
  .setDescription('Challenge another player to a NetBattle duel')
  .addUserOption(o =>
    o
      .setName('user')
      .setDescription('Player to challenge')
      .setRequired(true),
  );

export async function execute(ix: ChatInputCommandInteraction) {
  await createPvpChallenge(ix);
}

export async function onButton(ix: ButtonInteraction) {
  await handlePvpButton(ix);
}

export async function onSelect(ix: StringSelectMenuInteraction) {
  await handlePvpSelect(ix);
}
