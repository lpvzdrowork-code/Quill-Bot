import {
    ActionRowBuilder,
    ApplicationCommandOptionType,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    MessageFlags,
    SlashCommandBuilder,
    StringSelectMenuBuilder,
} from 'discord.js';
import type { BotCommand } from '../../types/index.js';
import { client } from '../../client.js';
import { config } from '../../config.js';

// ─── Help ─────────────────────────────────────────────────────────────────────
// Interactive help menu. Opens on an overview of every category; a select
// menu jumps to a category, and long categories (Moderation) are paginated
// with Previous/Next buttons.
//
// Nothing here is hardcoded per-command. Every command is auto-tagged with a
// `category` in commandLoader.ts based on which /commands subfolder it lives
// in, and usage strings are derived from each command's own option definitions,
// so adding or removing a command file is the only maintenance this ever needs.
// Only the category labels/blurbs/order below are manual.

const PER_PAGE      = 8;
const TIMEOUT_MS    = 3 * 60 * 1000;
const OVERVIEW      = 'overview';
const SELECT_ID     = 'help_category';
const PREV_ID       = 'help_prev';
const NEXT_ID       = 'help_next';

const CATEGORY_ORDER = ['moderation', 'config', 'info', 'tools', 'testing', 'general'];

const CATEGORY_LABELS: Record<string, string> = {
    moderation: 'Moderation',
    config:     'Configuration',
    info:       'Information',
    tools:      'Tools',
    testing:    'Testing',
    general:    'General',
};

const CATEGORY_BLURBS: Record<string, string> = {
    moderation: 'Enforce rules, manage members, and keep channels in order.',
    config:     'Set up how Quill behaves in your server.',
    info:       'Learn about Quill and check its status.',
    tools:      'Utilities for staff and announcements.',
    testing:    'Diagnostics for checking that Quill is responding.',
    general:    'Everything else.',
};

// ─── Catalog ──────────────────────────────────────────────────────────────────

interface Category {
    key:      string;
    label:    string;
    blurb:    string;
    commands: BotCommand[];
}

function titleCase(text: string): string {
    return text.charAt(0).toUpperCase() + text.slice(1);
}

function buildCatalog(): Category[] {
    const groups = new Map<string, BotCommand[]>();

    for (const cmd of client.commands.values()) {
        const key = cmd.category ?? 'general';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(cmd);
    }

    const known = CATEGORY_ORDER.filter(key => groups.has(key));
    const extra = [...groups.keys()].filter(key => !CATEGORY_ORDER.includes(key)).sort();

    return [...known, ...extra].map(key => ({
        key,
        label:    CATEGORY_LABELS[key] ?? titleCase(key),
        blurb:    CATEGORY_BLURBS[key] ?? '',
        commands: groups.get(key)!.sort((a, b) => a.data.name.localeCompare(b.data.name)),
    }));
}

// ─── Usage Strings ────────────────────────────────────────────────────────────
// "/ban <user> [reason]" — required options in <angle>, optional in [square].
// Commands with subcommands show the branches instead: "/embed <create | edit>".

function usageOf(cmd: BotCommand): string {
    const json    = cmd.data.toJSON();
    const options = json.options ?? [];
    const name    = `/${json.name}`;

    if (options.length === 0) return name;

    const isBranch = options.some(o =>
        o.type === ApplicationCommandOptionType.Subcommand ||
        o.type === ApplicationCommandOptionType.SubcommandGroup,
    );

    const usage = isBranch
        ? `${name} <${options.map(o => o.name).join(' | ')}>`
        : `${name} ${options.map(o => ('required' in o && o.required ? `<${o.name}>` : `[${o.name}]`)).join(' ')}`;

    return usage.length > 90 ? `${usage.slice(0, 89)}…` : usage;
}

function entryOf(cmd: BotCommand): string {
    return `**\`${usageOf(cmd)}\`**\n${cmd.data.description}`;
}

// ─── Embeds ───────────────────────────────────────────────────────────────────

function overviewEmbed(catalog: Category[]): EmbedBuilder {
    const embed = new EmbedBuilder()
        .setColor(config.colors.info)
        .setTitle(`${config.meta.name} Help`)
        .setDescription(
            `${client.commands.size} commands across ${catalog.length} categories.\n` +
            'Pick a category from the menu below to see what each command does.',
        )
        .setFooter({ text: `${config.meta.footer}  •  v${config.meta.version}` });

    for (const cat of catalog) {
        const names = cat.commands.map(c => `\`${c.data.name}\``).join('  ');
        const value = cat.blurb ? `${cat.blurb}\n${names}` : names;

        embed.addFields({
            name:   `${cat.label} (${cat.commands.length})`,
            value:  value.length > 1024 ? `${value.slice(0, 1023)}…` : value,
            inline: false,
        });
    }

    return embed;
}

function pageCountOf(cat: Category): number {
    return Math.max(1, Math.ceil(cat.commands.length / PER_PAGE));
}

function categoryEmbed(cat: Category, page: number): EmbedBuilder {
    const pages = pageCountOf(cat);
    const slice = cat.commands.slice(page * PER_PAGE, (page + 1) * PER_PAGE);

    const body = slice.map(entryOf).join('\n\n');
    const head = cat.blurb ? `${cat.blurb}\n\n` : '';

    const footer = pages > 1
        ? `Page ${page + 1} of ${pages}  •  ${config.meta.footer}`
        : config.meta.footer;

    return new EmbedBuilder()
        .setColor(config.colors.info)
        .setTitle(`${cat.label} Commands`)
        .setDescription(`${head}${body}`.slice(0, 4096))
        .setFooter({ text: footer });
}

// ─── Components ───────────────────────────────────────────────────────────────

function selectRow(catalog: Category[], view: string): ActionRowBuilder<StringSelectMenuBuilder> {
    const menu = new StringSelectMenuBuilder()
        .setCustomId(SELECT_ID)
        .setPlaceholder('Browse a category')
        .addOptions(
            {
                label:       'Overview',
                value:       OVERVIEW,
                description: 'Every category at a glance',
                default:     view === OVERVIEW,
            },
            ...catalog.map(cat => ({
                label:       cat.label,
                value:       cat.key,
                description: `${cat.commands.length} command${cat.commands.length === 1 ? '' : 's'}`,
                default:     view === cat.key,
            })),
        );

    return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

function buttonRow(page: number, pages: number, disabled = false): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId(PREV_ID)
            .setLabel('Previous')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(disabled || page === 0),
        new ButtonBuilder()
            .setCustomId(NEXT_ID)
            .setLabel('Next')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(disabled || page >= pages - 1),
    );
}

// ─── Command ──────────────────────────────────────────────────────────────────

const command: BotCommand = {
    data: new SlashCommandBuilder()
        .setName('help')
        .setDescription('Shows all available Quill commands.'),

    async execute(interaction) {
        const catalog = buildCatalog();

        let view = OVERVIEW;
        let page = 0;

        const current = () => catalog.find(c => c.key === view);

        function render() {
            const cat   = current();
            const pages = cat ? pageCountOf(cat) : 1;

            return {
                embeds:     [cat ? categoryEmbed(cat, page) : overviewEmbed(catalog)],
                components: [
                    selectRow(catalog, view),
                    ...(pages > 1 ? [buttonRow(page, pages)] : []),
                ],
            };
        }

        await interaction.reply({ ...render(), flags: MessageFlags.Ephemeral });
        const message = await interaction.fetchReply();

        const collector = message.createMessageComponentCollector({
            filter: i => i.user.id === interaction.user.id,
            time:   TIMEOUT_MS,
        });

        collector.on('collect', async i => {
            if (i.isStringSelectMenu()) {
                view = i.values[0] ?? OVERVIEW;
                page = 0;
            } else if (i.isButton()) {
                const cat = current();
                if (cat) {
                    const pages = pageCountOf(cat);
                    if (i.customId === PREV_ID) page = Math.max(0, page - 1);
                    if (i.customId === NEXT_ID) page = Math.min(pages - 1, page + 1);
                }
            }

            await i.update(render());
        });

        collector.on('end', async () => {
            // Strip the controls once the menu expires so nothing looks clickable.
            await interaction.editReply({ components: [] }).catch(() => null);
        });
    },
};

export default command;
