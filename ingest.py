#!/usr/bin/env python3
"""
Ingest script for custom-harness development project.
Converts project artifacts into structured wiki entries.
"""

import os
import json
import yaml
from pathlib import Path
from datetime import datetime
import re

def extract_date_from_filename(filename):
    """Extract date from filename patterns like 2026-05-07"""
    date_pattern = r'(\d{4}-\d{2}-\d{2})'
    match = re.search(date_pattern, filename)
    if match:
        return match.group(1)
    return None

def extract_date_from_git(filepath):
    """Try to get creation date from git"""
    try:
        import subprocess
        result = subprocess.run(['git', 'log', '--reverse', '--format=%ai', '--', filepath], 
                              capture_output=True, text=True)
        if result.stdout.strip():
            git_date = result.stdout.strip().split('\n')[0]
            return git_date.split()[0]  # Extract just YYYY-MM-DD
    except:
        pass
    return None

def get_file_date(filepath):
    """Get the best available date for a file"""
    filename = Path(filepath).name
    
    # Try filename first
    date = extract_date_from_filename(filename)
    if date:
        return date
    
    # Try git history
    date = extract_date_from_git(filepath)
    if date:
        return date
    
    # Fall back to file modification time
    mtime = os.path.getmtime(filepath)
    return datetime.fromtimestamp(mtime).strftime('%Y-%m-%d')

def clean_content(content):
    """Clean up content for wiki entry"""
    # Remove excessive whitespace
    content = re.sub(r'\n\s*\n\s*\n', '\n\n', content)
    return content.strip()

def ingest_markdown_file(filepath, source_type="markdown"):
    """Convert a markdown file to a wiki entry"""
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()
    
    # Extract frontmatter if present
    frontmatter = {}
    if content.startswith('---'):
        try:
            parts = content.split('---', 2)
            if len(parts) >= 3:
                frontmatter = yaml.safe_load(parts[1])
                content = parts[2].strip()
        except:
            pass
    
    # Get title (first # header or filename)
    title = None
    lines = content.split('\n')
    for line in lines:
        if line.startswith('# '):
            title = line[2:].strip()
            break
    
    if not title:
        title = Path(filepath).stem.replace('-', ' ').replace('_', ' ').title()
    
    date = get_file_date(filepath)
    
    # Create unique ID
    file_id = f"{Path(filepath).parent.name}_{Path(filepath).stem}".replace('/', '_').replace(' ', '_')
    
    entry = {
        'id': file_id,
        'date': date,
        'time': '12:00:00',  # Default time
        'source_type': source_type,
        'filepath': str(filepath),
        'title': title,
        'category': Path(filepath).parent.name,
        **frontmatter
    }
    
    return entry, clean_content(content)

def ingest_project_files():
    """Ingest all relevant project files"""
    entries = []
    
    # Define file patterns to ingest
    patterns = [
        'docs/**/*.md',
        '*.md',
        'progress.md',
        'research.md',
        'CONTEXT.md',
        'AGENTS.md',
        'runs/reference/*.txt'
    ]
    
    for pattern in patterns:
        for filepath in Path('.').glob(pattern):
            if filepath.is_file() and filepath.name != 'README.md':  # Skip generic README
                try:
                    entry, content = ingest_markdown_file(filepath)
                    
                    # Skip empty files
                    if not content.strip():
                        continue
                    
                    # Write entry file
                    entry_filename = f"{entry['date']}_{entry['id']}.md"
                    entry_path = Path('raw/entries') / entry_filename
                    
                    # Create frontmatter
                    frontmatter_lines = ['---']
                    for key, value in entry.items():
                        if isinstance(value, str):
                            frontmatter_lines.append(f'{key}: "{value}"')
                        elif isinstance(value, list):
                            frontmatter_lines.append(f'{key}: {json.dumps(value)}')
                        else:
                            frontmatter_lines.append(f'{key}: {value}')
                    frontmatter_lines.append('---')
                    frontmatter_lines.append('')
                    
                    full_content = '\n'.join(frontmatter_lines) + content
                    
                    with open(entry_path, 'w', encoding='utf-8') as f:
                        f.write(full_content)
                    
                    entries.append(entry)
                    print(f"Ingested: {filepath} -> {entry_filename}")
                
                except Exception as e:
                    print(f"Error processing {filepath}: {e}")
    
    return entries

def main():
    """Main ingest function"""
    # Create output directory
    Path('raw/entries').mkdir(parents=True, exist_ok=True)
    
    print("Ingesting custom-harness development project...")
    entries = ingest_project_files()
    
    print(f"\nIngested {len(entries)} entries:")
    for entry in sorted(entries, key=lambda x: x['date']):
        print(f"  {entry['date']} - {entry['title']} ({entry['category']})")
    
    print(f"\nEntries written to raw/entries/")
    print("Run `/wiki absorb all` to compile into wiki articles.")

if __name__ == '__main__':
    main()