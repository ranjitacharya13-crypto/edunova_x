const fs = require("fs");
const path = require("path");

// Output file
const outputFile = "full_project_code.txt";

// Clear previous content
fs.writeFileSync(outputFile, "", "utf8");

// Function to read all files with folder structure
function readAll(dir, indent = "") {
  const items = fs.readdirSync(dir);

  items.forEach(item => {
    const fullPath = path.join(dir, item);

    if (fs.statSync(fullPath).isDirectory()) {
      fs.appendFileSync(outputFile, `\n${indent}[Folder] ${item}\n`, "utf8");
      readAll(fullPath, indent + "  "); // increase indent for subfolders
    } else {
      fs.appendFileSync(outputFile, `${indent}-- ${item} --\n`, "utf8");
      const fileContent = fs.readFileSync(fullPath, "utf8");
      fs.appendFileSync(outputFile, fileContent + "\n", "utf8");
    }
  });
}

readAll("./");

console.log(`✅ All project code with folder structure saved to ${outputFile}`);
