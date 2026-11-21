// The app: adds two amounts and draws a bar.
MODS.app = {
  run: () => MODS.format.money(MODS.core.add(2, 3)) + " " + MODS.charts.bar(3),
};
