<template>
  <!--
    GodePalette — paleta de pigmentos oficial da aplicação.
    Renderiza uma fileira de pastilhas de cor no tema escuro + um seletor de
    cor livre (input type=color nativo, zero dependências) para escolher
    qualquer cor fora da paleta fixa.
  -->
  <div class="gode" role="group" aria-label="Paleta de cores">
    <button
      v-for="pigmento in godePigmentos"
      :key="pigmento.hex"
      type="button"
      class="gode__pan"
      :class="{ 'gode__pan--selected': isSelected(pigmento.hex) }"
      :style="{ '--pan-color': pigmento.hex }"
      :title="pigmento.nome"
      :aria-label="`Selecionar pigmento: ${pigmento.nome}`"
      :aria-pressed="isSelected(pigmento.hex)"
      @click="selectPigmento(pigmento.hex)"
    >
      <span class="gode__pan-disc" aria-hidden="true" />
    </button>

    <!-- Divisória entre a paleta fixa e o seletor livre. -->
    <span class="gode__divider" aria-hidden="true" />

    <!--
      Seletor de cor livre. O chip mostra a cor atual; ao clicar abre o color
      picker nativo do navegador. Marcado como selecionado quando a cor ativa
      não pertence à paleta fixa (i.e. é uma cor customizada).
    -->
    <label
      class="gode__pan gode__pan--custom"
      :class="{ 'gode__pan--selected': isCustomSelected }"
      :style="{ '--pan-color': modelValue }"
      title="Cor personalizada"
    >
      <span class="gode__pan-disc gode__pan-disc--custom" aria-hidden="true">+</span>
      <input
        type="color"
        class="gode__color-input"
        :value="modelValue"
        aria-label="Escolher cor personalizada"
        @input="selectPigmento($event.target.value)"
      />
    </label>
  </div>
</template>

<script setup>
/**
 * @file GodePalette.vue
 * @description Componente de seleção de cor: paleta fixa de pigmentos + seletor
 * de cor livre. Não possui estado de desenho — apenas emite a cor escolhida via
 * v-model (`update:modelValue`) seguindo a convenção padrão do Vue 3.
 *
 * @emits update:modelValue - hex string da cor selecionada.
 *
 * @example
 * <GodePalette v-model="selectedColor" />
 */

import { computed } from 'vue';

/**
 * @typedef {{ nome: string, hex: string }} Pigmento
 */

/** @type {Pigmento[]} */
const godePigmentos = [
  { nome: 'Azul Ultramar',           hex: '#120A8F' },
  { nome: 'Amarelo Ocre',            hex: '#E3A857' },
  { nome: 'Alizarin Crimson',        hex: '#E32636' },
  { nome: 'Verde Seiva',             hex: '#507D2A' },
  { nome: 'Cinza de Payne',          hex: '#536878' },
  { nome: 'Terra de Siena Queimada', hex: '#E97451' },
  { nome: 'Preto Marfim',            hex: '#1C1C1C' },
];

const props = defineProps({
  /**
   * Cor atualmente selecionada (hex). Bind com `v-model` a partir do pai.
   * @type {string}
   */
  modelValue: {
    type: String,
    default: '#120A8F',
  },
});

const emit = defineEmits(['update:modelValue']);

/** Conjunto (lowercase) dos hex da paleta fixa, para detectar cor custom. */
const paletteHexes = new Set(godePigmentos.map((p) => p.hex.toLowerCase()));

/**
 * Verdadeiro quando a cor ativa não pertence à paleta fixa — usado para
 * marcar o chip de cor livre como selecionado.
 * @type {import('vue').ComputedRef<boolean>}
 */
const isCustomSelected = computed(
  () => !paletteHexes.has((props.modelValue || '').toLowerCase()),
);

/**
 * Compara um hex da paleta com a cor selecionada (case-insensitive).
 * @param {string} hex
 * @returns {boolean}
 */
function isSelected(hex) {
  return hex.toLowerCase() === (props.modelValue || '').toLowerCase();
}

/**
 * Emite a atualização de v-model quando o usuário escolhe uma cor.
 * @param {string} hex
 */
function selectPigmento(hex) {
  emit('update:modelValue', hex);
}
</script>

<style scoped>
/* ── Container da paleta ───────────────────────────────────── */
.gode {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  flex-wrap: wrap;
}

/* ── Pastilha individual ───────────────────────────────────── */
.gode__pan {
  position: relative;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  padding: 0;
  border: none;
  cursor: pointer;
  background: transparent;

  /* Anel de seleção — transparente por padrão. */
  outline: 2px solid transparent;
  outline-offset: 2px;
  transition: outline-color 0.15s ease, transform 0.12s ease;
}

.gode__pan:hover {
  transform: scale(1.18);
}

.gode__pan:focus-visible {
  outline-color: var(--accent);
}

.gode__pan--selected {
  outline-color: var(--accent);
  transform: scale(1.2);
}

/* ── Disco de pigmento ─────────────────────────────────────── */
.gode__pan-disc {
  display: block;
  width: 100%;
  height: 100%;
  border-radius: 50%;

  background: radial-gradient(
    circle at 38% 35%,
    color-mix(in srgb, var(--pan-color) 60%, #fff 40%) 0%,
    var(--pan-color) 65%,
    color-mix(in srgb, var(--pan-color) 78%, #000 22%) 100%
  );

  box-shadow:
    inset 0 2px 4px rgba(0, 0, 0, 0.35),
    inset 0 -1px 2px rgba(255, 255, 255, 0.18);
}

/* ── Divisória ─────────────────────────────────────────────── */
.gode__divider {
  width: 1px;
  height: 24px;
  background: var(--border);
  margin: 0 0.15rem;
}

/* ── Seletor de cor livre ──────────────────────────────────── */
.gode__pan--custom {
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.gode__pan-disc--custom {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1.1rem;
  font-weight: 700;
  line-height: 1;
  color: #fff;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.5);
  border: 1px dashed rgba(255, 255, 255, 0.5);
}

/* input nativo invisível cobrindo o chip — o disco é a UI visível. */
.gode__color-input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  opacity: 0;
  cursor: pointer;
  border: none;
  padding: 0;
}
</style>
