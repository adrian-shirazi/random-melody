# Random Melody
Generates a random melody to inspire and challenge musical artists. Takes a few
user parameters such as tempo, length, and then goes buck-wild. 

## Usage
1) npm init -y && npm i typescript ts-node @types/node midi-writer-js
2) npx tsc --init --rootDir src --outDir dist --esModuleInterop true --module commonjs --target es2020
3) save as src/melody-generator.ts
4) run: npx ts-node src/melody-generator.ts --measures=4 --tempo=110 --seed=hello
5) Outputs JSON to console and writes out.mid
