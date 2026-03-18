function getDisplayNameFromInteraction(interaction) {
  return interaction.member?.displayName
    || interaction.user?.globalName
    || interaction.user?.displayName
    || interaction.user?.username
    || 'Unknown User';
}

function getDisplayNameFromUserInGuild(interaction, user) {
  const member = interaction.guild?.members?.cache?.get(user.id);
  return member?.displayName
    || user?.globalName
    || user?.displayName
    || user?.username
    || 'Unknown User';
}

function getDisplayNameFromMessage(message) {
  return message.member?.displayName
    || message.author?.globalName
    || message.author?.displayName
    || message.author?.username
    || 'Unknown User';
}

module.exports = {
  getDisplayNameFromInteraction,
  getDisplayNameFromUserInGuild,
  getDisplayNameFromMessage,
};
